import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Usage } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, ExtUiResponse } from "@thinkrail/contracts";
import { saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	compactSession,
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	getSessionStats,
	promptSession,
	queuedMessages,
	removeSession,
	resolveExtUi,
	sendSteeringNow,
	setExtUiPublisher,
	setSessionPublisher,
	steerSession,
} from "./sdkSessionManager";
import { readSessionRecord, writeSessionRecord } from "./sessionStore";

const savedEnvironment = Object.fromEntries(
	["THINKRAIL_DATA_DIR", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [
		key,
		process.env[key],
	]),
);
let root: string;
let worktree: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-recovery-audit-"));
	worktree = join(root, "worktree");
	mkdirSync(worktree);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "offline-test-key";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Audit",
			branch: "test",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
});
afterEach(() => {
	disposeAllSessions();
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	setSessionPublisher(() => {});
	for (const [key, value] of Object.entries(savedEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const done = () => modelResponse([assistantMessage("done")]);
function reply(request: ExtUiRequest): ExtUiResponse {
	if (
		request.kind !== "confirm" ||
		!request.runId ||
		request.revision === undefined ||
		!request.toolCallId
	)
		throw new Error("Expected a fully anchored tool approval");
	return {
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		toolCallId: request.toolCallId,
		value: true,
	};
}
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("The session did not reach the expected state");
		await Bun.sleep(1);
	}
}

test("tool approval requires its call ID before acceptance and on durable decision replay", async () => {
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"bash",
				JSON.stringify({ command: "printf once >> audit.marker", timeoutMs: 10000 }),
				{
					callId: "audit-call",
				},
			),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	let saved: ExtUiResponse | undefined;
	setExtUiPublisher((request) => {
		if (request.kind !== "confirm") return;
		const response = reply(request);
		const { toolCallId: _callId, ...missingCall } = response;
		expect(() => resolveExtUi(missingCall)).toThrow();
		expect(() => resolveExtUi({ ...response, toolCallId: "wrong-call" })).toThrow();
		resolveExtUi(response);
		saved = response;
	});
	await promptSession(sessionId, "run the approved command");
	if (!saved) throw new Error("No approval was issued");
	const accepted = saved;
	expect(readFileSync(join(worktree, "audit.marker"), "utf8")).toBe("once");
	await removeSession(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	const { toolCallId: _callId, ...missingCall } = accepted;
	expect(() => resolveExtUi(missingCall)).toThrow();
	expect(() => resolveExtUi({ ...accepted, toolCallId: "wrong-call" })).toThrow();
	resolveExtUi(accepted);
	expect(readFileSync(join(worktree, "audit.marker"), "utf8")).toBe("once");
	model.assertComplete();
});

test("a valid response to the first restored approval snapshot does not race graph recovery", async () => {
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"bash",
				JSON.stringify({ command: "printf once >> restored.marker", timeoutMs: 10000 }),
				{
					callId: "restore-call",
				},
			),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const ready = Promise.withResolvers<void>();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.resolve();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "run once after restore");
	await ready.promise;
	await removeSession(sessionId);
	await running;
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	const pending = snapshot.summary.state?.needsInput;
	if (pending?.kind !== "dialog") throw new Error("The first snapshot lost its approval");
	resolveExtUi(reply(pending.request));
	await until(() => getSessionState(sessionId).execution === "idle");
	expect(readFileSync(join(worktree, "restored.marker"), "utf8")).toBe("once");
	model.assertComplete();
});

test("queued input can retry after model construction fails before history admission", async () => {
	configureAgentModelFactory(() => {
		throw new Error("model construction failed");
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	steerSession(sessionId, "retain this exact input", undefined, "retry-input");
	await until(() => getSessionState(sessionId).completion?.outcome === "failed");
	expect(queuedMessages(sessionId).steering[0]).toMatchObject({
		id: "retry-input",
		state: "pending",
	});
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	await sendSteeringNow(sessionId);
	expect(model.calls).toHaveLength(1);
	expect(queuedMessages(sessionId).steering).toEqual([]);
	expect(
		readSessionRecord(sessionId)?.messages.filter((message) => message.id === "retry-input"),
	).toHaveLength(1);
	model.assertComplete();
});

test("an unknown effect has a model-visible result on continuation and never executes again", async () => {
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("No session record");
	const command = "printf forbidden > unknown-effect.marker";
	record.state.execution = "running";
	record.state.runId = "lost-run";
	record.history = [
		{ type: "message", role: "user", id: "lost-input", content: "run the command" },
		{
			type: "function_call",
			callId: "lost-call",
			name: "bash",
			arguments: JSON.stringify({ command, timeoutMs: 10000 }),
			status: "completed",
		},
	];
	record.effects["lost-call"] = {
		runId: "lost-run",
		name: "bash",
		arguments: { command, timeoutMs: 10000 },
		status: "started",
	};
	writeSessionRecord(record);
	disposeAllSessions();
	await getSessionMessages(sessionId, "workspace", worktree);
	expect(getSessionState(sessionId).completion?.outcome).toBe("interrupted");
	expect(model.calls).toHaveLength(0);
	await promptSession(sessionId, "continue without retrying that operation");
	const input = model.calls[0]?.request.input;
	if (!Array.isArray(input)) throw new Error("The model did not receive item history");
	expect(
		input.filter((item) => item.type === "function_call" && item.callId === "lost-call"),
	).toHaveLength(1);
	const output = input.find(
		(item) => item.type === "function_call_result" && item.callId === "lost-call",
	);
	expect(output?.type === "function_call_result" ? output.output : "").toContain("unknown");
	expect(existsSync(join(worktree, "unknown-effect.marker"))).toBe(false);
	model.assertComplete();
});

test("summary SDK usage counts once in session statistics and remains counted after reopen", async () => {
	const model = new ScriptedModel([
		modelResponse({
			usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 3, totalTokens: 13 }),
			output: [assistantMessage("a".repeat(600))],
		}),
		modelResponse({
			usage: new Usage({ requests: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24 }),
			output: [assistantMessage("recent answer")],
		}),
		modelResponse({
			usage: new Usage({
				requests: 1,
				inputTokens: 30,
				outputTokens: 5,
				totalTokens: 35,
				inputTokensDetails: [{ cached_tokens: 2, cache_write_tokens: 1 }],
			}),
			output: [assistantMessage("Keep fact alpha.")],
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, `fact alpha ${"x".repeat(600)}`);
	await promptSession(sessionId, "recent exchange");
	await compactSession(sessionId, { operationId: "usage-audit" });
	const expected = { input: 60, output: 12, cacheRead: 2, cacheWrite: 1, total: 72 };
	expect(getSessionStats(sessionId).tokens).toEqual(expected);
	await compactSession(sessionId, { operationId: "usage-audit" });
	expect(model.calls).toHaveLength(3);
	expect(getSessionStats(sessionId).tokens).toEqual(expected);
	await removeSession(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	expect(getSessionStats(sessionId).tokens).toEqual(expected);
	model.assertComplete();
});

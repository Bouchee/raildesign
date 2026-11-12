import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, ExtUiResponse, SessionEventPayload } from "@thinkrail/contracts";
import { saveWorkspaces } from "../persistence";
import { setTrashImplementationForTests } from "../trash";
import { configureAgentModelFactory, saveCustomEndpoint } from "./modelConfiguration";
import {
	abortSession,
	createSession,
	deleteSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	getSessionStats,
	liveSessionIdsOf,
	promptSession,
	removeSession,
	renameSession,
	resolveExtUi,
	setExtUiPublisher,
	setSessionPublisher,
	setSessionResourceCleanup,
} from "./sdkSessionManager";
import { applyWorkspacePatch, type ToolGrant } from "./sdkTools";
import { readSessionRecord, sessionRecordPath } from "./sessionStore";

let root: string;
let worktree: string;
const originalEnvironment = {
	data: process.env.THINKRAIL_DATA_DIR,
	key: process.env.OPENAI_API_KEY,
	base: process.env.OPENAI_BASE_URL,
	model: process.env.OPENAI_MODEL,
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-agent-test-"));
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
			name: "Test",
			branch: "test",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
});
afterEach(() => {
	setSessionResourceCleanup(undefined);
	disposeAllSessions();
	setTrashImplementationForTests(undefined);
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	setSessionPublisher(() => {});
	for (const [name, value] of Object.entries({
		THINKRAIL_DATA_DIR: originalEnvironment.data,
		OPENAI_API_KEY: originalEnvironment.key,
		OPENAI_BASE_URL: originalEnvironment.base,
		OPENAI_MODEL: originalEnvironment.model,
	})) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const command = (callId: string, command: string) =>
	modelResponse([functionCall("bash", JSON.stringify({ command, timeoutMs: 10000 }), { callId })]);
const done = () => modelResponse([assistantMessage("done")]);
function approvalResponse(request: ExtUiRequest, value: boolean): ExtUiResponse {
	if (request.kind !== "confirm" || !request.runId || request.revision === undefined)
		throw new Error("Expected owned approval");
	return {
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		value,
	};
}

test("SDK stream projects stable IDs, persists history once and settles with its watermark", async () => {
	const model = new ScriptedModel([done()]);
	const conversationIds: string[] = [];
	configureAgentModelFactory((_model, sessionId) => {
		conversationIds.push(sessionId);
		return model;
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "say done");
	const snapshot = await getSessionMessages(created.sessionId, "workspace", worktree);
	expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
	expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(
		snapshot.messages.length,
	);
	const lastFrame = frames.at(-1);
	if (!lastFrame) throw new Error("No event frames");
	expect(snapshot.eventSeq).toBe(lastFrame.seq);
	expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
	expect(
		readSessionRecord(created.sessionId)?.history.filter(
			(item) => "role" in item && item.role === "user",
		),
	).toHaveLength(1);
	expect(getSessionStats(created.sessionId).cost).toBeNull();
	model.enqueue(done());
	await promptSession(created.sessionId, "continue the same conversation");
	expect(conversationIds).toEqual([created.sessionId, created.sessionId]);
	expect(model.calls.map((call) => call.request.modelSettings.providerData)).toEqual([
		{ extra_headers: { "User-Agent": "RailDesign/0.1" } },
		{ extra_headers: { "User-Agent": "RailDesign/0.1" } },
	]);
	model.assertComplete();
});

test("failed input admission launches no model and leaves the session available for a later send", async () => {
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const directory = join(root, "data", "sessions");
	const saved = join(root, "saved-sessions");
	renameSync(directory, saved);
	writeFileSync(directory, "not a directory");
	expect(() => promptSession(created.sessionId, "must not be accepted")).toThrow();
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(created.sessionId).execution).toBe("idle");
	rmSync(directory);
	renameSync(saved, directory);
	await promptSession(created.sessionId, "accepted after repair");
	expect(
		readSessionRecord(created.sessionId)?.messages.filter((message) => message.role === "user"),
	).toHaveLength(1);
	model.assertComplete();
});

test("owned approval executes once, duplicate reply is idempotent and cross-session reply fails", async () => {
	const model = new ScriptedModel([
		command(
			"approved",
			"printf once >> count.txt; if printenv OPENAI_API_KEY > key.txt; then :; else printf unset > key.txt; fi",
		),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const other = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const receipts: ExtUiResponse[] = [];
	setExtUiPublisher((request) => {
		if (request.kind !== "confirm") return;
		const receipt = approvalResponse(request, true);
		receipts.push(receipt);
		const waiting = readSessionRecord(created.sessionId)?.pendingApproval;
		if (!waiting) throw new Error("Approval was published before persistence");
		expect(waiting.request).toMatchObject(request);
		expect(waiting.checkpoint.length).toBeGreaterThan(0);
		expect(existsSync(join(worktree, "count.txt"))).toBe(false);
		expect(() => resolveExtUi({ ...receipt, sessionId: other.sessionId })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, runId: "another-run" })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, revision: (receipt.revision ?? 0) + 1 })).toThrow(
			"stale",
		);
		expect(() => resolveExtUi({ ...receipt, id: "unknown-interaction" })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, value: "yes" })).toThrow("stale");
		resolveExtUi(receipt);
		const accepted = readSessionRecord(created.sessionId);
		expect(accepted?.pendingApproval).toBeUndefined();
		expect(accepted?.decisions[request.id]).toEqual({
			runId: waiting.request.runId,
			revision: waiting.request.revision,
			value: true,
		});
		resolveExtUi(receipt);
	});
	await promptSession(created.sessionId, "run once");
	expect(readFileSync(join(worktree, "count.txt"), "utf8")).toBe("once");
	expect(readFileSync(join(worktree, "key.txt"), "utf8")).toBe("unset");
	expect(
		readSessionRecord(created.sessionId)?.history.filter(
			(item) => "role" in item && item.role === "user",
		),
	).toHaveLength(1);
	const receipt = receipts[0];
	if (!receipt) throw new Error("No approval card");
	expect(() => resolveExtUi({ ...receipt, value: false })).toThrow("Conflicting");
	model.assertComplete();
});

test("rejected approval never starts its executor", async () => {
	const model = new ScriptedModel([command("denied", "printf forbidden > forbidden.txt"), done()]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, false));
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "request a command");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	expect(frames.some((frame) => frame.event.type === "tool_execution_start")).toBe(false);
	expect(
		readSessionRecord(created.sessionId)?.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "denied",
		),
	).toMatchObject({ isError: true });
	model.assertComplete();
});

test("tool failure status follows actual execution and preserves successful error-shaped file text", async () => {
	const contents = '{"isError":true}\nAn error occurred while running the tool';
	writeFileSync(join(worktree, "fixture.txt"), contents);
	const model = new ScriptedModel([
		modelResponse([
			functionCall("read", { path: "fixture.txt" }, { callId: "successful-read" }),
			functionCall("read", { path: "missing.txt" }, { callId: "failed-read" }),
			functionCall("read", "{invalid", { callId: "malformed-read" }),
		]),
		command("failed-command", "printf failed-command; exit 7"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "read the files and run the command");
	const results = readSessionRecord(created.sessionId)?.messages.filter(
		(message) => message.role === "toolResult",
	);
	expect(results).toHaveLength(4);
	expect(results?.find((message) => message.toolCallId === "successful-read")).toMatchObject({
		isError: false,
		content: [{ type: "text", text: contents }],
	});
	for (const callId of ["successful-read", "failed-read", "malformed-read", "failed-command"]) {
		const failed = callId !== "successful-read";
		expect(results?.find((message) => message.toolCallId === callId)).toMatchObject({
			isError: failed,
		});
		const endings = frames.filter(
			(frame) => frame.event.type === "tool_execution_end" && frame.event.toolCallId === callId,
		);
		expect(endings).toHaveLength(1);
		expect(endings[0]?.event).toMatchObject({ isError: failed });
	}
	model.assertComplete();
});

test("a model key referenced by an arbitrary environment name is not inherited by commands", async () => {
	const previous = process.env.SERVICE_ACCESS;
	process.env.SERVICE_ACCESS = "not-a-real-key";
	try {
		await saveCustomEndpoint({
			name: "Go",
			baseUrl: "https://opencode.ai/inference/go/openai/v1",
			apiKey: "$SERVICE_ACCESS",
			models: [
				{
					id: "deepseek-v4.1-flash",
					contextWindow: null,
					maxTokens: 32,
					reasoning: null,
					vision: null,
					tools: true,
				},
			],
		});
		const model = new ScriptedModel([
			command(
				"key-isolation",
				"if printenv SERVICE_ACCESS > key.txt; then :; else printf unset > key.txt; fi",
			),
			done(),
		]);
		configureAgentModelFactory(() => model);
		setExtUiPublisher((request) => {
			if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
		});
		const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(created.sessionId, "check child environment");
		expect(readFileSync(join(worktree, "key.txt"), "utf8")).toBe("unset");
		model.assertComplete();
	} finally {
		if (previous === undefined) delete process.env.SERVICE_ACCESS;
		else process.env.SERVICE_ACCESS = previous;
	}
});

test("Stop during approval revokes the run, rejects stale replies and prevents a second Runner", async () => {
	const model = new ScriptedModel([command("waiting", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	let card: ExtUiRequest | undefined;
	let ready: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			ready?.();
		}
	});
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(created.sessionId, "request approval");
	await waiting;
	expect(() => promptSession(created.sessionId, "second run")).toThrow("already active");
	await abortSession(created.sessionId);
	await running;
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("cancelled");
	if (!card) throw new Error("Missing card");
	const stoppedReply = approvalResponse(card, true);
	expect(() => resolveExtUi(stoppedReply)).toThrow("stale");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});

test("a deleted workspace cannot authorize a tool when its worktree is the host cwd", async () => {
	const previousCwd = process.cwd();
	process.chdir(worktree);
	const cwd = process.cwd();
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "test",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	const model = new ScriptedModel([
		command("removed-workspace", "printf forbidden > forbidden.txt"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	let ready: (request: ExtUiRequest) => void = () => {};
	const approval = new Promise<ExtUiRequest>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready(request);
	});
	const created = await createSession({ cwd, workspaceId: "workspace" });
	const running = promptSession(created.sessionId, "request approval");
	try {
		const request = await approval;
		saveWorkspaces([]);
		expect(() => resolveExtUi(approvalResponse(request, true))).toThrow("permission");
	} finally {
		await abortSession(created.sessionId);
		await running;
		process.chdir(previousCwd);
	}
	expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
	expect(model.remainingSteps).toBe(1);
});

test.skipIf(process.platform === "win32")(
	"Stop waits for an executing command tree and its next model call cannot start afterwards",
	async () => {
		const model = new ScriptedModel([
			command(
				"running",
				"(sleep 1; printf forbidden > orphan.txt) & echo $! > child.pid; printf ready > ready.txt; wait",
			),
			modelResponse([
				functionCall(
					"apply_patch",
					{ path: "later.txt", original: null, diff: "+forbidden\n" },
					{ callId: "later" },
				),
			]),
		]);
		configureAgentModelFactory(() => model);
		setExtUiPublisher((request) => {
			if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
		});
		const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
		const running = promptSession(created.sessionId, "run command");
		const deadline = Date.now() + 3000;
		while (!existsSync(join(worktree, "ready.txt"))) {
			if (Date.now() > deadline) throw new Error("Command did not start");
			await Bun.sleep(10);
		}
		const pid = Number(readFileSync(join(worktree, "child.pid"), "utf8"));
		await abortSession(created.sessionId);
		await running;
		expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(join(worktree, "orphan.txt"))).toBe(false);
		expect(existsSync(join(worktree, "later.txt"))).toBe(false);
		expect(model.remainingSteps).toBe(1);
		expect(getSessionState(created.sessionId).completion?.outcome).toBe("cancelled");
	},
);

test("patch validates original text, symlinks, new ancestors, .git and revoked grants", () => {
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(outside, join(worktree, "escape"));
	mkdirSync(join(worktree, ".git"));
	let active = true;
	const grant: ToolGrant = {
		workspaceId: "workspace",
		cwd: worktree,
		signal: new AbortController().signal,
		assertActive: () => {
			if (!active) throw new Error("revoked");
		},
	};
	for (const path of [
		"../outside/secret.txt",
		"escape/secret.txt",
		"escape/new/deep.txt",
		".git/config",
	])
		expect(() => applyWorkspacePatch(grant, { path, diff: "+changed", original: null })).toThrow();
	writeFileSync(join(worktree, "file.txt"), "before\n");
	expect(() =>
		applyWorkspacePatch(grant, {
			path: "file.txt",
			diff: "@@\n-before\n+after\n",
			original: "wrong\n",
		}),
	).toThrow("Original text changed");
	applyWorkspacePatch(grant, {
		path: "file.txt",
		diff: "@@\n-before\n+after\n",
		original: "before\n",
	});
	expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("after\n");
	active = false;
	expect(() =>
		applyWorkspacePatch(grant, {
			path: "file.txt",
			diff: "@@\n-after\n+forbidden\n",
			original: "after\n",
		}),
	).toThrow("revoked");
	expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
});

test("automatic titles cannot overwrite a manual title or another accepted automatic title", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const manual = renameSession(sessionId, "workspace", worktree, "Manual name");
	const automatic = renameSession(sessionId, "workspace", worktree, "Automatic name", {
		onlyIfUnnamed: true,
	});
	expect(await manual).toBe(true);
	expect(await automatic).toBe(false);
	expect(readSessionRecord(sessionId)?.title).toBe("Manual name");
	const next = await createSession({ cwd: worktree, workspaceId: "workspace" });
	expect(
		await renameSession(next.sessionId, "workspace", worktree, "First title", {
			onlyIfUnnamed: true,
		}),
	).toBe(true);
	expect(
		await renameSession(next.sessionId, "workspace", worktree, "Second title", {
			onlyIfUnnamed: true,
		}),
	).toBe(false);
	expect(readSessionRecord(next.sessionId)?.title).toBe("First title");
});

test("resource cleanup settles before detaching a session and failures leave it attached", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	let finish: (() => void) | undefined;
	setSessionResourceCleanup(async (id) => {
		expect(id).toBe(sessionId);
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const pending = removeSession(sessionId);
	await Bun.sleep(0);
	expect(liveSessionIdsOf("workspace")).toContain(sessionId);
	finish?.();
	await pending;
	expect(liveSessionIdsOf("workspace")).not.toContain(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	setSessionResourceCleanup(async () => {
		throw new Error("resources still active");
	});
	await expect(removeSession(sessionId)).rejects.toThrow("resources still active");
	expect(liveSessionIdsOf("workspace")).toContain(sessionId);
});

test("session deletion uses recoverable trash and a failed trash preserves its transcript", async () => {
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const path = sessionRecordPath(created.sessionId);
	setTrashImplementationForTests(async () => {
		throw new Error("trash unavailable");
	});
	await expect(deleteSession(created.sessionId, "workspace", worktree)).rejects.toThrow(
		"trash unavailable",
	);
	expect(readSessionRecord(created.sessionId)?.sessionId).toBe(created.sessionId);
	await getSessionMessages(created.sessionId, "workspace", worktree);
	const trashed = join(root, "recoverable-session.json");
	setTrashImplementationForTests(async (source) => {
		if (typeof source !== "string") throw new Error("Expected one transcript");
		renameSync(source, trashed);
	});
	await deleteSession(created.sessionId, "workspace", worktree);
	expect(existsSync(path)).toBe(false);
	expect(JSON.parse(readFileSync(trashed, "utf8")).sessionId).toBe(created.sessionId);
});

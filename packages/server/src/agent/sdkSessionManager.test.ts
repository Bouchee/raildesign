import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
import { applyDiff, Usage } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, ExtUiResponse, SessionEventPayload } from "@thinkrail/contracts";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import { TodoStore } from "@thinkrail/todos/core";
import { loadConfig, saveConfig, saveWorkspaces } from "../persistence";
import { setTrashImplementationForTests } from "../trash";
import { configureAgentModelFactory, saveCustomEndpoint } from "./modelConfiguration";
import {
	abortSession,
	clearSessionQueue,
	compactSession,
	createSession,
	deleteSession,
	disposeAllSessions,
	followUpSession,
	getSessionMessages,
	getSessionState,
	getSessionStats,
	liveSessionIdsOf,
	nudgeSession,
	promptSession,
	queuedMessages,
	removeQueuedMessage,
	removeSession,
	renameSession,
	resolveExtUi,
	respondToTool,
	sendSteeringNow,
	setExtUiPublisher,
	setSessionPublisher,
	setSessionResourceCleanup,
	setSessionStatePublisher,
	steerSession,
	updateQueuedMessage,
} from "./sdkSessionManager";
import { applyWorkspacePatch, type ToolGrant, workspaceTools } from "./sdkTools";
import { readSessionRecord, sessionRecordPath } from "./sessionStore";
import { setWebAccessKey } from "./webAccess";
import { setContinueToolHost, setWorkspaceToolsHost } from "./workspaceActions";

let root: string;
let worktree: string;
let webFetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
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
	webFetchMock?.mockRestore();
	webFetchMock = undefined;
	setSessionResourceCleanup(undefined);
	setWorkspaceToolsHost(undefined);
	setContinueToolHost(undefined);
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
function offlineWeb(reply: (request: Request) => Response | Promise<Response>) {
	const implementation = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => reply(new Request(input, init));
	webFetchMock = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: () => {} }),
	);
	return webFetchMock;
}

test("a root SDK run completes more than twenty sequential tool rounds", async () => {
	writeFileSync(join(worktree, "fixture.txt"), "fixture bytes");
	const model = new ScriptedModel([
		...Array.from({ length: 21 }, (_, index) =>
			modelResponse([functionCall("read", { path: "fixture.txt" }, { callId: `read-${index}` })]),
		),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Read the fixture in twenty-one sequential rounds, then finish.");
	expect(model.calls).toHaveLength(22);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	expect(
		readSessionRecord(sessionId)?.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "read" && !message.isError,
		),
	).toHaveLength(21);
});

test("SDK web tools keep renderer metadata in restored transcripts and readable text in model history", async () => {
	setWebAccessKey("offline-platform-key");
	const requests: string[] = [];
	offlineWeb((request) => {
		requests.push(request.url);
		return request.url.endsWith("/search")
			? Response.json({
					results: [{ title: "Source", url: "https://example.com/page", summary: "Summary" }],
				})
			: Response.json({ title: "Page", content: "Page body" });
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall("web_search", { query: "example", count: 1 }, { callId: "web-search" }),
		]),
		modelResponse([
			functionCall("web_fetch", { url: "https://example.com/page" }, { callId: "web-fetch" }),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Search and read the result");
	expect(requests).toEqual([
		"https://api.deepseek.com/v1/tools/search",
		"https://api.deepseek.com/v1/tools/fetch",
	]);
	const results = readSessionRecord(sessionId)?.messages.filter(
		(item) => item.role === "toolResult",
	);
	if (!results) throw new Error("Missing web transcript");
	expect(results).toEqual([
		expect.objectContaining({
			toolCallId: "web-search",
			content: [{ type: "text", text: "Source\nhttps://example.com/page\nSummary" }],
			details: {
				provider: "DeepSeek",
				results: [{ title: "Source", url: "https://example.com/page", summary: "Summary" }],
			},
			isError: false,
		}),
		expect.objectContaining({
			toolCallId: "web-fetch",
			content: [{ type: "text", text: "# Page\n\nPage body" }],
			details: {
				provider: "DeepSeek",
				title: "Page",
				url: "https://example.com/page",
				truncated: false,
			},
			isError: false,
		}),
	]);
	const input = model.calls[2]?.request.input;
	if (!Array.isArray(input)) throw new Error("Missing web continuation input");
	expect(input.filter((item) => item.type === "function_call_result")).toEqual([
		expect.objectContaining({
			callId: "web-search",
			output: { type: "text", text: "Source\nhttps://example.com/page\nSummary" },
		}),
		expect.objectContaining({
			callId: "web-fetch",
			output: { type: "text", text: "# Page\n\nPage body" },
		}),
	]);
	expect(JSON.stringify(input)).not.toContain('"provider":"DeepSeek"');
	await removeSession(sessionId);
	const restored = await getSessionMessages(sessionId, "workspace", worktree);
	expect(restored.messages.filter((item) => item.role === "toolResult")).toEqual(results);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	model.assertComplete();
});

test("a disabled web extension is absent from the SDK graph and cannot execute", async () => {
	saveConfig({ ...loadConfig(), disabledExtensions: ["web-access"] });
	const fetch = offlineWeb(() => Response.json({ results: [] }));
	const model = new ScriptedModel([
		modelResponder(({ request }) => {
			expect(JSON.stringify(request.tools)).not.toContain("web_search");
			expect(JSON.stringify(request.tools)).not.toContain("web_fetch");
			return [
				functionCall("web_search", { query: "blocked", count: 1 }, { callId: "disabled-web" }),
			];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Try a disabled web tool");
	expect(fetch).not.toHaveBeenCalled();
	expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
	expect(readSessionRecord(sessionId)?.effects["disabled-web"]).toBeUndefined();
	model.assertComplete();
});

test("Stop cancels an SDK web request before a late result can enter the transcript", async () => {
	setWebAccessKey("offline-platform-key");
	const started = latch();
	let cancelled = false;
	offlineWeb(
		() =>
			new Response(
				new ReadableStream({
					start() {
						started.release();
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const model = new ScriptedModel([
		modelResponse([
			functionCall("web_fetch", { url: "https://example.com/page" }, { callId: "stopped-web" }),
		]),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "Read the page");
	await started.promise;
	await abortSession(sessionId);
	await running;
	expect(cancelled).toBe(true);
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	expect(
		readSessionRecord(sessionId)?.messages.some(
			(item) =>
				item.role === "toolResult" &&
				item.toolCallId === "stopped-web" &&
				item.details !== undefined,
		),
	).toBe(false);
	model.assertComplete();
});

function approvalResponse(request: ExtUiRequest, value: boolean): ExtUiResponse {
	if (
		request.kind !== "confirm" ||
		!request.runId ||
		request.revision === undefined ||
		!request.toolCallId
	)
		throw new Error("Expected owned approval");
	return {
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		toolCallId: request.toolCallId,
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
			toolCallId: waiting.request.toolCallId,
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
			functionCall("read", { path: null }, { callId: "invalid-read" }),
			functionCall("skill_read", { name: "", path: null }, { callId: "invalid-skill-read" }),
			functionCall("skill_search", { query: "", limit: null }, { callId: "invalid-skill-search" }),
			functionCall("todo_list", "{invalid", { callId: "invalid-todo" }),
			functionCall("spec_search", "{invalid", { callId: "invalid-spec" }),
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
	expect(results).toHaveLength(9);
	expect(results?.find((message) => message.toolCallId === "successful-read")).toMatchObject({
		isError: false,
		content: [{ type: "text", text: contents }],
	});
	for (const callId of [
		"successful-read",
		"failed-read",
		"malformed-read",
		"failed-command",
		"invalid-read",
		"invalid-skill-read",
		"invalid-skill-search",
		"invalid-todo",
		"invalid-spec",
	]) {
		const failed = callId !== "successful-read";
		expect(results?.find((message) => message.toolCallId === callId)).toMatchObject({
			isError: failed,
		});
		const endings = frames.filter(
			(frame) => frame.event.type === "tool_execution_end" && frame.event.toolCallId === callId,
		);
		expect(endings).toHaveLength(1);
		expect(endings[0]?.event).toMatchObject({ isError: failed });
		if (!["malformed-read", "invalid-todo", "invalid-spec"].includes(callId))
			expect(readSessionRecord(created.sessionId)?.effects[callId]?.isError).toBe(failed);
		else expect(readSessionRecord(created.sessionId)?.effects[callId]).toBeUndefined();
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

test("patch exposes executable SDK diff examples and exact-original guidance to the model", () => {
	const patch = workspaceTools({
		workspaceId: "workspace",
		cwd: worktree,
		signal: new AbortController().signal,
		assertActive() {},
	}).find((entry) => entry.name === "apply_patch");
	const schema = patch?.parameters as { properties?: Record<string, { description?: string }> };
	const description = schema.properties?.diff?.description ?? "";
	const existingExample = description.match(/@@\n-before\n\+after\n/)?.[0];
	const createExample = description.match(/\+first line\n\+second line\n/)?.[0];
	expect(existingExample).toBeDefined();
	expect(createExample).toBeDefined();
	expect(applyDiff("before\n", existingExample ?? "")).toBe("after\n");
	expect(applyDiff("", createExample ?? "", "create")).toBe("first line\nsecond line");
	expect(schema.properties?.original?.description).toMatch(/exact entire.*original/i);
	expect(schema.properties?.original?.description).toMatch(/null only.*new file/i);
});

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

function latch() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function settled(sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (getSessionState(sessionId).execution === "idle") return;
		await Bun.sleep(10);
	}
	throw new Error("SDK test run did not settle");
}

test("an idle TODO nudge executes the SDK tools once and survives retry after reattachment", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const todos = new TodoStore(worktree, sessionId);
	const todo = todos.add({ title: "manual task", origin: "user" });
	const model = new ScriptedModel([
		modelResponse([functionCall("todo_list", {}, { callId: "list-added" })]),
		modelResponse([
			functionCall("todo_update", { id: todo.id, status: "done" }, { callId: "complete-added" }),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const text = `${TODO_NUDGE_PREFIX}Read and complete the manual task.`;
	const messageId = `todo-nudge-${todo.id}`;
	expect(nudgeSession(sessionId, text, messageId)).toEqual({ disposition: "prompted" });
	nudgeSession(sessionId, text, messageId);
	await settled(sessionId);
	expect(todos.get(todo.id)?.status).toBe("done");
	expect(readSessionRecord(sessionId)).toMatchObject({
		state: { completion: { outcome: "succeeded" } },
	});
	expect(
		readSessionRecord(sessionId)?.history.filter((item) => item.id === messageId),
	).toHaveLength(1);
	expect(readSessionRecord(sessionId)?.messages.some((item) => item.id === messageId)).toBe(false);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	await removeSession(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	nudgeSession(sessionId, text, messageId);
	expect(model.calls).toHaveLength(3);
	expect(() => nudgeSession(sessionId, `${text} conflicting`, messageId)).toThrow("Conflicting");
	model.assertComplete();
});

test("a running TODO nudge is a follow-up after normal settlement and never steering", async () => {
	const ready = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			ready.release();
			await finish.promise;
			return [functionCall("todo_list", {}, { callId: "original-list" })];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "original");
	await ready.promise;
	const text = `${TODO_NUDGE_PREFIX}Read the updated list.`;
	expect(nudgeSession(sessionId, text, "todo-nudge-queued")).toEqual({ disposition: "queued" });
	nudgeSession(sessionId, text, "todo-nudge-queued");
	followUpSession(sessionId, "withdraw this user input", undefined, "withdrawable");
	expect(clearSessionQueue(sessionId).followUp).toEqual([
		expect.objectContaining({ id: "withdrawable" }),
	]);
	expect(readSessionRecord(sessionId)?.queue).toEqual([
		expect.objectContaining({ id: "todo-nudge-queued", kind: "followUp", internal: true }),
	]);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const middle = model.calls[1]?.request.input;
	const last = model.calls[2]?.request.input;
	if (!Array.isArray(middle) || !Array.isArray(last)) throw new Error("Missing model history");
	expect(middle.some((item) => item.id === "todo-nudge-queued")).toBe(false);
	expect(last.filter((item) => item.id === "todo-nudge-queued")).toHaveLength(1);
	model.assertComplete();
});

test("TODO nudges cannot bypass a pending approval", async () => {
	const model = new ScriptedModel([command("block-nudge", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "wait for approval");
	await ready.promise;
	const request = getSessionState(sessionId).needsInput;
	expect(nudgeSession(sessionId, `${TODO_NUDGE_PREFIX}New item`, "todo-nudge-blocked")).toEqual({
		disposition: "needs_input",
	});
	expect(getSessionState(sessionId).needsInput).toEqual(request);
	expect(readSessionRecord(sessionId)?.queue).toEqual([]);
	await abortSession(sessionId);
	await run;
	expect(model.calls).toHaveLength(1);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});

test("Stop discards stale internal TODO follow-ups and keeps their durable retry identity", async () => {
	const ready = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			ready.release();
			await finish.promise;
			return [assistantMessage("late")];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "original");
	await ready.promise;
	const text = `${TODO_NUDGE_PREFIX}Do not revive after Stop.`;
	nudgeSession(sessionId, text, "todo-nudge-stop");
	followUpSession(sessionId, "user follow-up", undefined, "user-kept");
	const stopping = abortSession(sessionId);
	finish.release();
	await stopping;
	await run;
	expect(readSessionRecord(sessionId)?.queue.map((item) => item.id)).toEqual(["user-kept"]);
	nudgeSession(sessionId, text, "todo-nudge-stop");
	expect(model.calls).toHaveLength(1);
});

test("SDK workspace actions reach the host services with run identity and structured results", async () => {
	const starts: string[] = [];
	setWorkspaceToolsHost({
		start: async (sessionId, params, signal) => {
			signal.throwIfAborted();
			starts.push(sessionId);
			expect(params).toEqual({ prompt: "independent task", project: "project" });
			return {
				workspaceId: "side-workspace",
				projectId: "project",
				sessionId: "side-chat",
				name: "Side",
				branch: "side",
				baseBranch: "main",
				model: null,
				effort: "off",
			};
		},
		status: async (sessionId, params) => {
			expect(starts).toEqual([sessionId]);
			expect(params).toEqual({ workspaces: ["side-workspace"] });
			return "Side: completed";
		},
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"start_workspace",
				{
					prompt: "independent task",
					project: "project",
					base_branch: null,
					model: null,
					effort: null,
					attachments: null,
				},
				{ callId: "start-side" },
			),
		]),
		modelResponse([
			functionCall(
				"workspace_status",
				{ workspaces: ["side-workspace"], project: null },
				{ callId: "side-status" },
			),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Start another workspace and check it");
	expect(starts).toEqual([sessionId]);
	expect(
		readSessionRecord(sessionId)?.messages.find(
			(item) => item.role === "toolResult" && item.toolCallId === "start-side",
		),
	).toMatchObject({
		isError: false,
		details: { workspaceId: "side-workspace", sessionId: "side-chat" },
	});
	model.assertComplete();
});

test("Stop during workspace admission aborts the host signal and rejects the late tool result", async () => {
	const ready = latch();
	const finish = latch();
	let receivedSignal: AbortSignal | undefined;
	setWorkspaceToolsHost({
		start: async (_sessionId, _params, signal) => {
			receivedSignal = signal;
			ready.release();
			await finish.promise;
			signal.throwIfAborted();
			throw new Error("Unexpected admission after Stop");
		},
		status: async () => "unused",
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"start_workspace",
				{
					prompt: "side",
					project: null,
					base_branch: null,
					model: null,
					effort: null,
					attachments: null,
				},
				{ callId: "stopped-side" },
			),
		]),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "Start workspace");
	await ready.promise;
	const stopped = abortSession(sessionId);
	expect(receivedSignal?.aborted).toBe(true);
	finish.release();
	await stopped;
	await run;
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	expect(model.calls).toHaveLength(1);
	expect(
		readSessionRecord(sessionId)?.messages.find(
			(item) => item.role === "toolResult" && item.toolCallId === "stopped-side",
		),
	).toMatchObject({ isError: true });
});
test("steering reaches the next model boundary once and remains separate from follow-ups", async () => {
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	writeFileSync(join(worktree, "fixture.txt"), "fixture");
	const started = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			started.release();
			await finish.promise;
			return [functionCall("read", { path: "fixture.txt" }, { callId: "continue" })];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial", undefined, "initial");
	await started.promise;
	followUpSession(sessionId, "after completion", undefined, "follow");
	steerSession(sessionId, "correct direction", undefined, "steer");
	expect(queuedMessages(sessionId).steering[0]).toMatchObject({ id: "steer", state: "staged" });
	expect(() => removeQueuedMessage(sessionId, "steer")).toThrow("Staged");
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const next = model.calls[1]?.request.input;
	if (!Array.isArray(next)) throw new Error("Missing model input");
	expect(next.filter((item) => item.id === "steer")).toHaveLength(1);
	expect(next.some((item) => item.id === "follow")).toBe(false);
	expect(readSessionRecord(sessionId)?.history.filter((item) => item.id === "steer")).toHaveLength(
		1,
	);
	expect(readSessionRecord(sessionId)?.messages.filter((item) => item.id === "steer")).toHaveLength(
		1,
	);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
	model.assertComplete();
});
test("unused in-flight steering starts before followups after terminal response", async () => {
	const started = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			started.release();
			await finish.promise;
			return [assistantMessage("first done")];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial");
	await started.promise;
	followUpSession(sessionId, "follow", undefined, "follow");
	steerSession(sessionId, "steer", undefined, "steer");
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const second = model.calls[1]?.request.input;
	if (!Array.isArray(second)) throw new Error("Missing next input");
	expect(second.filter((item) => item.id === "steer")).toHaveLength(1);
	expect(second.some((item) => item.id === "follow")).toBe(false);
	model.assertComplete();
});
test("Stop preserves pending followups for editing and withdraws by stable input ID", async () => {
	const model = new ScriptedModel([command("wait", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial");
	await ready.promise;
	followUpSession(sessionId, "queued", undefined, "queued");
	await abortSession(sessionId);
	await run;
	expect(queuedMessages(sessionId).followUp).toEqual([
		{ id: "queued", text: "queued", state: "pending" },
	]);
	updateQueuedMessage(sessionId, "queued", "edited");
	expect(() => followUpSession(sessionId, "conflict", undefined, "queued")).toThrow("Conflicting");
	expect(removeQueuedMessage(sessionId, "queued").removed).toMatchObject({
		id: "queued",
		text: "edited",
	});
	expect(model.calls).toHaveLength(1);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});
test("closing and reattaching a pending approval rebuilds executors and executes the same call once", async () => {
	const model = new ScriptedModel([command("durable", "printf once >> once.txt"), done()]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	let card: ExtUiRequest | undefined;
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			ready.release();
		}
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "run durable");
	await ready.promise;
	const saved = readSessionRecord(sessionId)?.pendingApproval;
	if (!saved) throw new Error("No saved approval");
	await removeSession(sessionId);
	await running;
	expect(readSessionRecord(sessionId)?.pendingApproval?.request.id).toBe(saved.request.id);
	const restored = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			restored.release();
		}
	});
	await getSessionMessages(sessionId, "workspace", worktree);
	await restored.promise;
	if (!card) throw new Error("Missing restored card");
	expect(card.id).toBe(saved.request.id);
	resolveExtUi(approvalResponse(card, true));
	const deadline = Date.now() + 3000;
	while (getSessionState(sessionId).execution !== "idle") {
		if (Date.now() > deadline) throw new Error("Recovery did not settle");
		await Bun.sleep(5);
	}
	expect(readFileSync(join(worktree, "once.txt"), "utf8")).toBe("once");
	expect(readSessionRecord(sessionId)?.effects.durable).toMatchObject({ status: "completed" });
	resolveExtUi(approvalResponse(card, true));
	expect(readFileSync(join(worktree, "once.txt"), "utf8")).toBe("once");
	model.assertComplete();
});
test("manual summary uses the configured SDK model and successful replay makes no request", async () => {
	const model = new ScriptedModel([
		modelResponse([assistantMessage("a".repeat(600))]),
		done(),
		modelResponse({
			responseId: "summary-response",
			output: [assistantMessage("Keep fact alpha.")],
			usage: new Usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
		}),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, `fact alpha ${"x".repeat(600)}`);
	await promptSession(sessionId, "recent fact beta");
	const before = readSessionRecord(sessionId);
	const usageBefore = getSessionStats(sessionId).tokens;
	await compactSession(sessionId, { operationId: "summary" });
	expect(getSessionStats(sessionId).tokens.input).toBe(usageBefore.input + 100);
	expect(getSessionStats(sessionId).tokens.output).toBe(usageBefore.output + 20);
	const compacted = readSessionRecord(sessionId);
	expect(compacted?.history.length).toBeLessThan(before?.history.length ?? 0);
	expect(compacted?.messages.filter((item) => item.role !== "compactionSummary")).toEqual(
		before?.messages.filter((item) => item.role !== "compactionSummary"),
	);
	await promptSession(sessionId, "continue");
	const calls = model.calls.length;
	const usageAfter = getSessionStats(sessionId).tokens;
	const history = readSessionRecord(sessionId)?.history;
	await compactSession(sessionId, { operationId: "summary" });
	expect(model.calls.length).toBe(calls);
	expect(getSessionStats(sessionId).tokens).toEqual(usageAfter);
	expect(readSessionRecord(sessionId)?.history).toEqual(history);
	model.assertComplete();
});

test("a tool call interrupted by Stop does not block later summaries", async () => {
	const model = new ScriptedModel([
		command("stopped", "printf forbidden > forbidden.txt"),
		done(),
		done(),
		modelResponse([assistantMessage("Keep fact alpha.")]),
	]);
	configureAgentModelFactory(() => model);
	let ready: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready?.();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, `fact alpha ${"x".repeat(600)}`);
	await waiting;
	await abortSession(sessionId);
	await running;
	await promptSession(sessionId, "fact beta");
	await promptSession(sessionId, "recent fact gamma");
	const before = readSessionRecord(sessionId)?.history.length ?? 0;
	await compactSession(sessionId, { operationId: "after-stop" });
	expect(readSessionRecord(sessionId)?.history.length).toBeLessThan(before);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	model.assertComplete();
});

test("durable questions restore with their original identity and apply each valid answer once", async () => {
	const args = {
		questions: [
			{
				question: "Which color?",
				header: "Color",
				options: [
					{ label: "Blue", description: "Use blue" },
					{ label: "Red", description: "Use red" },
				],
			},
		],
	};
	const model = new ScriptedModel([
		modelResponse([functionCall("ask_user_question", args, { callId: "question" })]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const waiting = latch();
	setSessionStatePublisher((record) => {
		if (record.state.needsInput?.kind === "tool-response") waiting.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const other = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "ask for a color");
	await waiting.promise;
	const original = readSessionRecord(sessionId)?.pendingToolResponse;
	if (!original) throw new Error("Missing pending question");
	expect(
		nudgeSession(
			sessionId,
			`${TODO_NUDGE_PREFIX}Keep the question blocked.`,
			"todo-question-blocked",
		),
	).toEqual({ disposition: "needs_input" });
	expect(readSessionRecord(sessionId)?.pendingToolResponse).toEqual(original);
	expect(readSessionRecord(sessionId)?.queue).toEqual([]);
	await removeSession(sessionId);
	await running;
	saveConfig({
		...loadConfig(),
		disabledExtensions: ["ask-user-question"],
		extensionSettings: { "ask-user-question": { richPreviews: false } },
	});
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	const anchor = snapshot.summary.state?.needsInput;
	if (anchor?.kind !== "tool-response") throw new Error("No restored question anchor");
	expect(anchor.interactionId).toBe(original.id);
	const ownership = {
		interactionId: anchor.interactionId,
		runId: anchor.runId,
		revision: anchor.revision,
	};
	const answer = {
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Which color?", kind: "option", answer: "Blue" }],
	};
	expect(() => respondToTool(other.sessionId, "question", answer, ownership)).toThrow("stale");
	expect(() => respondToTool(sessionId, "other", answer, ownership)).toThrow("stale");
	expect(() =>
		respondToTool(sessionId, "question", answer, {
			...ownership,
			revision: ownership.revision + 1,
		}),
	).toThrow("stale");
	respondToTool(sessionId, "question", answer, ownership);
	respondToTool(sessionId, "question", answer, ownership);
	expect(() =>
		respondToTool(sessionId, "question", { ...answer, cancelled: true }, ownership),
	).toThrow("Conflicting");
	const deadline = Date.now() + 3000;
	while (getSessionState(sessionId).execution !== "idle") {
		if (Date.now() > deadline) throw new Error("Question did not settle");
		await Bun.sleep(5);
	}
	expect(
		readSessionRecord(sessionId)?.messages.filter(
			(item) => item.role === "custom" && item.customType === "tool-response",
		),
	).toHaveLength(1);
	expect(
		readSessionRecord(sessionId)?.history.filter(
			(item) => item.type === "function_call_result" && item.callId === "question",
		),
	).toHaveLength(1);
	const modelInput = model.calls[1]?.request.input;
	expect(JSON.stringify(model.calls[1]?.request.tools)).toContain("previewFile");
	expect(JSON.stringify(modelInput)).toContain("Blue");
	model.assertComplete();
	setSessionStatePublisher(() => {});
});
test("a queued input rejected before model admission can retry with the same ID", async () => {
	configureAgentModelFactory(() => {
		throw new Error("Model preparation failed");
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	steerSession(sessionId, "retry this", undefined, "retry");
	await Bun.sleep(0);
	expect(queuedMessages(sessionId).steering[0]).toMatchObject({
		id: "retry",
		state: "pending",
		error: "Model preparation failed",
	});
	updateQueuedMessage(sessionId, "retry", "edited retry");
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	await sendSteeringNow(sessionId);
	expect(JSON.stringify(model.calls[0]?.request.input)).toContain("edited retry");
	expect(readSessionRecord(sessionId)?.messages.filter((item) => item.id === "retry")).toHaveLength(
		1,
	);
	expect(readSessionRecord(sessionId)?.history.filter((item) => item.id === "retry")).toHaveLength(
		1,
	);
	expect(queuedMessages(sessionId).steering).toHaveLength(0);
	model.assertComplete();
});
test("restart exposes unknown effects, repairs model history, and never automatically executes them", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await removeSession(sessionId);
	const saved = readSessionRecord(sessionId);
	if (!saved) throw new Error("Missing record");
	saved.state.execution = "running";
	saved.state.runId = "interrupted-run";
	saved.effects.effect = {
		runId: "interrupted-run",
		name: "bash",
		arguments: { command: "printf forbidden > forbidden.txt", timeoutMs: 10000 },
		status: "started",
	};
	writeFileSync(sessionRecordPath(sessionId), JSON.stringify(saved));
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	expect(snapshot.summary.state?.completion?.outcome).toBe("interrupted");
	expect(model.calls).toHaveLength(0);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	expect(readSessionRecord(sessionId)?.effects.effect?.status).toBe("unknown");
	await promptSession(sessionId, "inspect before retrying");
	const input = model.calls[0]?.request.input;
	if (!Array.isArray(input)) throw new Error("Missing model history");
	expect(
		input.filter((item) => item.type === "function_call" && item.callId === "effect"),
	).toHaveLength(1);
	expect(
		input.filter((item) => item.type === "function_call_result" && item.callId === "effect"),
	).toHaveLength(1);
	expect(JSON.stringify(input)).toContain("result is unknown");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	model.assertComplete();
});

test("composer steering supersedes only the pending question and reaches continuation", async () => {
	const args = {
		questions: [
			{
				question: "Which color?",
				header: "Color",
				options: [{ label: "Blue", description: "Use blue" }],
			},
		],
	};
	const model = new ScriptedModel([
		modelResponse([functionCall("ask_user_question", args, { callId: "superseded-question" })]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setSessionStatePublisher((record) => {
		if (record.state.needsInput?.kind === "tool-response") ready.release();
	});
	let settled = 0;
	setSessionPublisher((frame) => {
		if (frame.event.type === "agent_settled") settled++;
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "ask color");
	await ready.promise;
	steerSession(sessionId, "Use green instead", undefined, "replacement");
	await running;
	const deadline = Date.now() + 3000;
	while (settled < 2 && Date.now() < deadline) await Bun.sleep(5);
	// The superseded question ends its run; the reply starts the next run.
	expect(settled).toBe(2);
	expect(model.calls).toHaveLength(2);
	expect(JSON.stringify(model.calls[1]?.request.input)).toContain("Use green instead");
	expect(readSessionRecord(sessionId)?.pendingToolResponse).toBeUndefined();
	expect(
		readSessionRecord(sessionId)?.messages.filter((item) => item.id === "replacement"),
	).toHaveLength(1);
	expect(getSessionState(sessionId).needsInput).toBeNull();
	model.assertComplete();
	setSessionStatePublisher(() => {});
});

test("new input cancels a detached summary and waits for its model cleanup before another Runner", async () => {
	const started = latch();
	let ended = false;
	const model = new ScriptedModel([
		modelResponse([assistantMessage("a".repeat(600))]),
		done(),
		modelResponder(async ({ request }) => {
			started.release();
			if (!request.signal) throw new Error("Missing summary signal");
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						ended = true;
						reject(new Error("summary cancelled"));
					},
					{ once: true },
				);
			});
			return [assistantMessage("never committed")];
		}),
		modelResponder(() => {
			expect(ended).toBe(true);
			return [assistantMessage("new response")];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, `history ${"x".repeat(600)}`);
	await promptSession(sessionId, "recent");
	const before = readSessionRecord(sessionId)?.history;
	const summary = compactSession(sessionId, { operationId: "cancelled-summary" }).catch(
		(error) => error,
	);
	await started.promise;
	await promptSession(sessionId, "new input");
	expect(await summary).toBeInstanceOf(Error);
	expect(readSessionRecord(sessionId)?.history.slice(0, before?.length)).toEqual(before);
	expect(readSessionRecord(sessionId)?.summaryOperations["cancelled-summary"]).toBeUndefined();
	model.assertComplete();
});

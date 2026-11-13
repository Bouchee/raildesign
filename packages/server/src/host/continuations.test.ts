import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
	type ScriptedModelInput,
} from "@openai/agents/testing";
import type { ChatContinuation, ChatCreateResult, ExtUiRequest } from "@thinkrail/contracts";
import {
	CHAT_HANDOFF_CUSTOM_TYPE,
	CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE,
} from "@thinkrail/contracts";
import * as agent from "../agent";
import {
	abortSession,
	configureAgentModelFactory,
	disposeAllSessions,
	followUpSession,
	getSessionMessages,
	getSessionState,
	initializeSessionStates,
	listSessionRecords,
	listSessions,
	promptSession,
	readSessionRecord,
	removeQueuedMessage,
	removeSession,
	resolveExtUi,
	setContinueToolHost,
	setExtUiPublisher,
	setSessionCreatedPublisher,
	setSessionPublisher,
	settleSessionsForShutdown,
} from "../agent";
import { loadChats, loadConfig, resetChatsStoreForTests, saveConfig } from "../persistence";
import { closeProject, openProject } from "../projects";
import { resetConfigCache } from "../settings";
import { setTrashImplementationForTests } from "../trash";
import { stopAllWatches } from "../watch";
import * as workspaces from "../workspaces";
import {
	createChatRecord,
	getWorkspace,
	listWorkspaceRecords,
	listWorkspaces,
	markChatDeletionPending,
	resetChatIdCache,
	setWorkspaceCreationHandoff,
} from "../workspaces";
import { startChatSession } from "./chatSession";
import { createChat } from "./chats";
import {
	applyContinuation,
	clearContinuations,
	continuationStatus,
	continueToolHost,
	observeContinuation,
	setContinuationPublisher,
	startContinuation,
} from "./continuations";
import { workspaceCreationHandoff } from "./handlers";
import { seedSdkTestModel } from "./sdkTestFixture";

let root: string;
const originalData = process.env.THINKRAIL_DATA_DIR;
const published: ChatContinuation[] = [];
const waiters = new Set<{
	match: (state: ChatContinuation) => boolean;
	resolve: (state: ChatContinuation) => void;
}>();
const models = new Map<string, ScriptedModel>();
const restored: Array<() => void> = [];
const done = (text = "done") => modelResponse([assistantMessage(text)]);
let callNumber = 0;
const summaryCall = (summary = "Keep the agreed design and implement its pending tests.") =>
	functionCall("continue_in_workspace", { summary }, { callId: `continue-${++callNumber}` });

function useModel(sessionId: string, steps: Iterable<ScriptedModelInput>): void {
	models.set(sessionId, new ScriptedModel(steps));
}

function phase(operationId: string, wanted: ChatContinuation["phase"]): Promise<ChatContinuation> {
	const match = (state: ChatContinuation) =>
		state.operationId === operationId && state.phase === wanted;
	const previous = published.find(match);
	if (previous) return Promise.resolve(previous);
	return new Promise((resolve) => waiters.add({ match, resolve }));
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if (!result.success) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

function project(name = "repo") {
	const path = join(root, name);
	mkdirSync(path);
	git(path, "init", "-b", "main");
	git(path, "config", "user.name", "test");
	git(path, "config", "user.email", "test@raildesign.test");
	git(path, "config", "commit.gpgsign", "false");
	writeFileSync(join(path, "README.md"), "# Fixture\n");
	git(path, "add", "README.md");
	git(path, "commit", "-m", "initial");
	return openProject(path);
}

async function promptedChat(): Promise<ChatCreateResult> {
	const chat = await createChat();
	await promptSession(chat.sessionId, "We agreed a design; its tests are still pending.");
	return chat;
}

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "raildesign-continuation-")));
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	resetConfigCache();
	resetChatIdCache();
	resetChatsStoreForTests();
	clearContinuations();
	published.length = 0;
	waiters.clear();
	models.clear();
	callNumber = 0;
	seedSdkTestModel(join(root, "data"), "continuation");
	configureAgentModelFactory((_model, sessionId) => {
		let model = models.get(sessionId);
		if (!model) {
			model = new ScriptedModel([done("Ready to continue.")]);
			models.set(sessionId, model);
		}
		return model;
	});
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input)
			rmSync(path, { recursive: true, force: true });
	});
	setContinueToolHost(continueToolHost);
	setContinuationPublisher((state) => {
		published.push(state);
		for (const waiter of waiters) {
			if (!waiter.match(state)) continue;
			waiters.delete(waiter);
			waiter.resolve(state);
		}
	});
	setSessionPublisher(({ sessionId, event }) => observeContinuation(sessionId, event));
	setWorkspaceCreationHandoff(workspaceCreationHandoff);
	await initializeSessionStates([]);
});

afterEach(async () => {
	for (const restore of restored.splice(0)) restore();
	await settleSessionsForShutdown();
	disposeAllSessions();
	stopAllWatches();
	setSessionCreatedPublisher(() => {});
	setExtUiPublisher(() => {});
	setSessionPublisher(() => {});
	setContinueToolHost(undefined);
	setContinuationPublisher(null);
	setWorkspaceCreationHandoff(null);
	setTrashImplementationForTests(undefined);
	configureAgentModelFactory();
	clearContinuations();
	resetConfigCache();
	resetChatIdCache();
	resetChatsStoreForTests();
	if (originalData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = originalData;
	rmSync(root, { recursive: true, force: true });
});

test("SDK summary calls create one workspace, one handoff and one persistent link, including parallel calls", async () => {
	const target = project();
	const source = await promptedChat();
	useModel(source.sessionId, [modelResponse([summaryCall(), summaryCall("Second copy.")]), done()]);
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	const started = await phase(operationId, "started");
	expect(started.firstMessage).toBe("sent");
	expect(published.map((state) => state.phase)).toEqual([
		"requested",
		"summarizing",
		"creating",
		"creating",
		"creating",
		"started",
	]);
	expect(
		listWorkspaceRecords(target.id).filter((workspace) => workspace.kind !== "default"),
	).toHaveLength(1);
	const workspace = getWorkspace(started.workspaceId ?? "");
	expect(await listSessions(workspace.id, workspace.worktreePath)).toHaveLength(1);
	const sourceMessages = (
		await getSessionMessages(source.sessionId, source.workspace.id, source.workspace.worktreePath)
	).messages;
	expect(sourceMessages.filter((message) => message.role === "user")).toHaveLength(1);
	expect(sourceMessages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE,
			details: { operationId, projectId: target.id, projectName: target.name },
		}),
	);
	const targetMessages = (
		await getSessionMessages(started.sessionId ?? "", workspace.id, workspace.worktreePath)
	).messages;
	expect(targetMessages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: CHAT_HANDOFF_CUSTOM_TYPE,
			details: expect.objectContaining({ sourceSessionId: source.sessionId }),
		}),
	);
	expect(targetMessages.filter((message) => message.role === "user")).toHaveLength(0);
	expect(loadChats().chats.find((chat) => chat.id === source.workspace.id)?.continuedTo).toEqual([
		{
			operationId,
			projectId: target.id,
			workspaceId: workspace.id,
			sessionId: started.sessionId ?? "",
		},
	]);
	clearContinuations();
	const { firstMessage: _firstMessage, ...linked } = started;
	expect(await continuationStatus(operationId)).toEqual(linked);
	await expect(continuationStatus("unknown")).rejects.toMatchObject({
		code: "CONTINUATION_UNKNOWN",
	});
}, 30_000);

test("busy source queues its request, concurrent gestures join, another target refuses, and queue edits retain the control input", async () => {
	const target = project();
	const other = project("other");
	const source = await promptedChat();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	useModel(source.sessionId, [
		modelResponder(async () => {
			entered.resolve();
			await release.promise;
			return [assistantMessage("Finished the earlier work.")];
		}),
		modelResponse([summaryCall()]),
		done(),
	]);
	const running = promptSession(source.sessionId, "Keep working.");
	await entered.promise;
	try {
		followUpSession(source.sessionId, "Removable question", undefined, "remove-me");
		const [first, second] = await Promise.all([
			startContinuation(source.workspace.id, target.id),
			startContinuation(source.workspace.id, target.id),
		]);
		expect(first).toEqual(second);
		await expect(startContinuation(source.workspace.id, other.id)).rejects.toMatchObject({
			code: "CONTINUATION_IN_FLIGHT",
		});
		removeQueuedMessage(source.sessionId, "remove-me");
		observeContinuation(source.sessionId, { type: "agent_settled", terminal: null });
		expect((await continuationStatus(first.operationId)).phase).toBe("summarizing");
		release.resolve();
		await running;
		await phase(first.operationId, "started");
		expect(JSON.stringify(readSessionRecord(source.sessionId)?.messages)).not.toContain(
			"Removable question",
		);
	} finally {
		release.resolve();
		await running;
	}
}, 30_000);

test("settlement without the summary tool fails, and Retry has a fresh operation", async () => {
	const target = project();
	const source = await promptedChat();
	useModel(source.sessionId, [done("No summary."), done("Still no summary.")]);
	const first = await startContinuation(source.workspace.id, target.id);
	expect((await phase(first.operationId, "failed")).reason).toContain("without a summary");
	await expect(
		applyContinuation(
			source.sessionId,
			"late",
			new AbortController().signal,
			() => {},
			"stale-input",
		),
	).rejects.toThrow("No continuation is pending");
	const retry = await startContinuation(source.workspace.id, target.id);
	expect(retry.operationId).not.toBe(first.operationId);
	await phase(retry.operationId, "failed");
	expect(
		listWorkspaceRecords(target.id).filter((workspace) => workspace.kind !== "default"),
	).toHaveLength(0);
});

test("Stop drops the queued summary request and never starts a destination", async () => {
	const target = project();
	const source = await promptedChat();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	useModel(source.sessionId, [
		modelResponder(async () => {
			entered.resolve();
			await release.promise;
			return [assistantMessage("Stopped.")];
		}),
	]);
	const running = promptSession(source.sessionId, "Keep working.");
	await entered.promise;
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	const stopping = abortSession(source.sessionId);
	release.resolve();
	await stopping;
	await running;
	expect((await phase(operationId, "failed")).reason).toContain("without a summary");
	expect(
		listWorkspaceRecords(target.id).filter((workspace) => workspace.kind !== "default"),
	).toHaveLength(0);
	expect(
		loadChats().chats.find((chat) => chat.id === source.workspace.id)?.continuedTo,
	).toBeUndefined();
});

test("Stop fails a queued continuation when the idle source is blocked by a child approval", async () => {
	const target = project();
	const source = await promptedChat();
	saveConfig({ ...loadConfig(), subagentsEnabled: true, subagentMaxConcurrent: 1 });
	resetConfigCache();
	const parent = new ScriptedModel([
		modelResponse([
			functionCall(
				"Agent",
				{
					subagent_type: "worker",
					task: "Run the requested check.",
					model: null,
					run_in_background: true,
				},
				{ callId: "background-child" },
			),
		]),
		done("Waiting for the child."),
	]);
	const child = new ScriptedModel([
		modelResponse([
			functionCall(
				"bash",
				{ command: "printf forbidden > forbidden.txt", timeoutMs: 1000 },
				{ callId: "child-approval" },
			),
		]),
	]);
	configureAgentModelFactory((_model, sessionId) =>
		sessionId === source.sessionId ? parent : child,
	);
	const blocked = Promise.withResolvers<void>();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") blocked.resolve();
	});
	await promptSession(source.sessionId, "Start a background check.");
	await blocked.promise;
	expect(getSessionState(source.sessionId).execution).toBe("idle");
	expect(getSessionState(source.sessionId).needsInput?.kind).toBe("dialog");
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	expect((await continuationStatus(operationId)).phase).toBe("summarizing");
	expect(parent.calls).toHaveLength(2);
	await abortSession(source.sessionId);
	expect((await phase(operationId, "failed")).reason).toContain("left the chat's queue");
	expect(listWorkspaceRecords(target.id)).toHaveLength(0);
	expect(parent.calls).toHaveLength(2);
});

test("empty chats, repository workspaces, unknown targets and pending chat deletions admit no operation", async () => {
	const target = project();
	const empty = await createChat();
	await expect(startContinuation(empty.workspace.id, target.id)).rejects.toThrow("no conversation");
	await expect(startContinuation(empty.workspace.id, "unknown")).rejects.toThrow(
		"Pick an open project",
	);
	const source = await promptedChat();
	markChatDeletionPending(source.workspace.id);
	await expect(startContinuation(source.workspace.id, target.id)).rejects.toMatchObject({
		code: "CHAT_DELETION_PENDING",
	});
	const workspace = (await listWorkspaces(target.id))[0];
	if (!workspace) throw new Error("No default workspace");
	await expect(startContinuation(workspace.id, target.id)).rejects.toMatchObject({
		code: "NOT_A_CHAT",
	});
	expect(published).toEqual([]);
});

test("closing the target after admission rejects the SDK tool before workspace creation", async () => {
	const target = project();
	const source = await promptedChat();
	useModel(source.sessionId, [
		modelResponder(() => {
			closeProject(target.id);
			return [summaryCall()];
		}),
		done(),
	]);
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	expect((await phase(operationId, "failed")).reason).toContain("project is no longer open");
	expect(published.some((state) => state.workspaceId)).toBe(false);
});

test("an old queued summary after restart cannot fulfill a new operation for another project", async () => {
	const firstProject = project();
	const nextProject = project("next-project");
	const source = await promptedChat();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	useModel(source.sessionId, [
		modelResponder(async () => {
			entered.resolve();
			await release.promise;
			return [assistantMessage("Interrupted work.")];
		}),
	]);
	const running = promptSession(source.sessionId, "Keep working.");
	await entered.promise;
	const old = await startContinuation(source.workspace.id, firstProject.id);
	disposeAllSessions();
	clearContinuations();
	release.resolve();
	await running;
	await expect(continuationStatus(old.operationId)).rejects.toMatchObject({
		code: "CONTINUATION_UNKNOWN",
	});
	useModel(source.sessionId, [
		modelResponse([summaryCall("Old summary for the earlier project.")]),
		done("The old request was refused."),
		modelResponse([summaryCall("Fresh summary for the next project.")]),
		done(),
	]);
	const next = await startContinuation(source.workspace.id, nextProject.id);
	const started = await phase(next.operationId, "started");
	expect(started.projectId).toBe(nextProject.id);
	expect(listWorkspaceRecords(firstProject.id)).toHaveLength(0);
	const messages = readSessionRecord(source.sessionId)?.messages ?? [];
	expect(messages).toContainEqual(
		expect.objectContaining({
			role: "toolResult",
			isError: true,
			content: [
				{
					type: "text",
					text: expect.stringContaining("This summary request is stale."),
				},
			],
		}),
	);
	const destination = readSessionRecord(started.sessionId ?? "");
	expect(JSON.stringify(destination?.messages)).toContain("Fresh summary for the next project.");
	expect(JSON.stringify(destination?.messages)).not.toContain(
		"Old summary for the earlier project.",
	);
}, 30_000);

test("a restored approval holds the continuation until the user resolves the original interaction", async () => {
	const target = project();
	const source = await promptedChat();
	let card: ExtUiRequest | undefined;
	let received = Promise.withResolvers<void>();
	setExtUiPublisher((request) => {
		if (request.kind !== "confirm") return;
		card = request;
		received.resolve();
	});
	useModel(source.sessionId, [
		modelResponse([
			functionCall(
				"bash",
				{ command: "printf once > approved.txt", timeoutMs: 1000 },
				{ callId: "held-command" },
			),
		]),
		done("Approved work completed."),
		modelResponse([summaryCall()]),
		done(),
	]);
	const running = promptSession(source.sessionId, "Wait for approval.");
	await received.promise;
	const pending = getSessionState(source.sessionId).needsInput;
	await removeSession(source.sessionId);
	await running;
	received = Promise.withResolvers<void>();
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	await received.promise;
	expect(getSessionState(source.sessionId).needsInput).toEqual(pending);
	expect(models.get(source.sessionId)?.calls).toHaveLength(1);
	expect((await continuationStatus(operationId)).phase).toBe("summarizing");
	expect(listWorkspaceRecords(target.id)).toHaveLength(0);
	if (card?.kind !== "confirm" || !card.runId || card.revision === undefined || !card.toolCallId)
		throw new Error("Missing restored approval");
	resolveExtUi({
		id: card.id,
		sessionId: card.sessionId,
		runId: card.runId,
		revision: card.revision,
		toolCallId: card.toolCallId,
		value: true,
	});
	await phase(operationId, "started");
	expect(readSessionRecord(source.sessionId)?.effects["held-command"]?.status).toBe("completed");
}, 30_000);

test("a failed destination chat is retried in its existing workspace", async () => {
	const target = project();
	const source = await promptedChat();
	const original = agent.createSession;
	const create = spyOn(agent, "createSession").mockImplementation((input) => {
		if (input.workspaceId !== source.workspace.id)
			throw new Error("Destination refused its session.");
		return original(input);
	});
	restored.push(() => create.mockRestore());
	useModel(source.sessionId, [modelResponse([summaryCall()]), done()]);
	const first = await startContinuation(source.workspace.id, target.id);
	const failed = await phase(first.operationId, "failed");
	expect(failed.reason).toContain("retry will reuse it");
	create.mockRestore();
	useModel(source.sessionId, [modelResponse([summaryCall()]), done()]);
	const retry = await startContinuation(source.workspace.id, target.id);
	const started = await phase(retry.operationId, "started");
	expect(started.workspaceId).toBe(failed.workspaceId);
	expect(
		listWorkspaceRecords(target.id).filter((workspace) => workspace.kind !== "default"),
	).toHaveLength(1);
}, 30_000);

test("a handoff admission failure preserves the created destination and reports delivery failure", async () => {
	const target = project();
	const source = await promptedChat();
	const original = agent.sendHostMessageToSession;
	const send = spyOn(agent, "sendHostMessageToSession").mockImplementation((...args) => {
		if (args[1] === CHAT_HANDOFF_CUSTOM_TYPE) throw new Error("Destination input unavailable.");
		return original(...args);
	});
	restored.push(() => send.mockRestore());
	useModel(source.sessionId, [modelResponse([summaryCall()]), done()]);
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	const started = await phase(operationId, "started");
	expect(started.firstMessage).toBe("failed");
	expect(
		loadChats().chats.find((chat) => chat.id === source.workspace.id)?.continuedTo?.[0]
			?.workspaceId,
	).toBe(started.workspaceId);
	expect(readSessionRecord(started.sessionId ?? "")?.messages).toHaveLength(0);
}, 30_000);

test("Stop after published creation preserves that workspace and prevents target input and link", async () => {
	const target = project();
	const source = await promptedChat();
	const original = workspaces.createWorkspaceWithChat;
	const creation = spyOn(workspaces, "createWorkspaceWithChat").mockImplementation(
		async (...args) => {
			const result = await original(...args);
			void abortSession(source.sessionId);
			return result;
		},
	);
	restored.push(() => creation.mockRestore());
	useModel(source.sessionId, [modelResponse([summaryCall()]), done()]);
	const { operationId } = await startContinuation(source.workspace.id, target.id);
	const failed = await phase(operationId, "failed");
	expect(failed.workspaceId).toBeTruthy();
	expect(failed.reason).toContain("retry will reuse it");
	const workspace = getWorkspace(failed.workspaceId ?? "");
	expect(await listSessions(workspace.id, workspace.worktreePath)).toHaveLength(0);
	expect(
		loadChats().chats.find((chat) => chat.id === source.workspace.id)?.continuedTo,
	).toBeUndefined();
	expect(listSessionRecords().some((record) => record.workspaceId === workspace.id)).toBe(false);
}, 30_000);

test("a revoked post-create claim cleans its new unused session and preserves its error", async () => {
	const workspace = createChatRecord();
	const error = new Error("creation claim revoked");
	let claims = 0;
	await expect(
		startChatSession(
			workspace,
			{},
			{
				assertClaimed: () => {
					if (++claims === 2) throw error;
				},
			},
		),
	).rejects.toBe(error);
	expect(await listSessions(workspace.id, workspace.worktreePath)).toHaveLength(0);
});

test("a revoked claim never deletes a newly visible session that has already received user input", async () => {
	const workspace = createChatRecord();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let running: Promise<void> | undefined;
	setSessionCreatedPublisher(({ sessionId }) => {
		useModel(sessionId, [
			modelResponder(async () => {
				entered.resolve();
				await release.promise;
				return [assistantMessage("Kept.")];
			}),
		]);
		running = promptSession(sessionId, "New user work.");
	});
	let claims = 0;
	try {
		await expect(
			startChatSession(
				workspace,
				{},
				{
					assertClaimed: () => {
						if (++claims === 2) throw new Error("claim revoked");
					},
				},
			),
		).rejects.toThrow("claim revoked");
		await entered.promise;
		expect(await listSessions(workspace.id, workspace.worktreePath)).toHaveLength(1);
	} finally {
		release.resolve();
		await running;
	}
});

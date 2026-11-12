import { afterEach, beforeEach, expect, onTestFinished, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type {
	AppConfig,
	ExtUiRequest,
	ExtUiResponse,
	Project,
	Template,
	TemplateInfo,
	WireModel,
	Workspace,
	WorkspaceCreation,
	WorkspaceCreationRemoved,
	WorkspaceWatchReadyResult,
} from "@thinkrail/contracts";
import {
	BRANCH_STATUS_PROTOCOL_VERSION,
	WORKSPACE_SETTLE_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import {
	type CreateSessionResult,
	closeWorkspaceSessions,
	configureAgentModelFactory,
	disposeAllSessions,
	getSessionState,
	readSessionRecord,
	sessionRecordPath,
	setExtUiPublisher,
} from "../agent";
import { sessionDirFor, writeFixtureSession } from "../history/testFixtures";
import { saveWorkspaces } from "../persistence";
import { addComment, getReviewSnapshot } from "../reviews";
import { resetConfigCache } from "../settings";
import { stopAllWatches } from "../watch";
import {
	awaitWorkspaceCreation,
	getWorkspace,
	setWorkspaceCreationHandoff,
	setWorkspaceCreationPublisher,
	setWorkspaceReview,
} from "../workspaces";
import {
	handleRequest,
	openReviewForClient,
	requestMethodDiagnostic,
	shouldRefreshOpenReview,
	workspaceCreationHandoff,
} from "./handlers";
import { seedSdkTestModel, useSdkTestModel } from "./sdkTestFixture";

const CTX = { clientKey: "test-client" };

let dataDir: string;
let repo: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const savedTestAgentDir = process.env.PI_CODING_AGENT_DIR;

async function setupDefaultModel(): Promise<() => void> {
	seedSdkTestModel(dataDir, "handler");
	configureAgentModelFactory(() => new ScriptedModel([modelResponse([assistantMessage("done")])]));
	return () => configureAgentModelFactory();
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed`);
}

function gitText(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed`);
	return new TextDecoder().decode(result.stdout).trim();
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-handlers-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi");
	resetConfigCache();
	repo = join(dataDir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@thinkrail.test");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([{ id: "p1", name: "repo", path: repo, slug: "repo", lastOpened: 1 }]),
	);
});

afterEach(() => {
	stopAllWatches();
	resetConfigCache();
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
	if (savedTestAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedTestAgentDir;
});

test("the current workspace and SDK methods are registered, and retired engine methods are unavailable", async () => {
	for (const method of [
		"project.open",
		"workspace.create",
		"session.create",
		"session.prompt",
		"session.abort",
		"session.extUiReply",
		"session.steer",
		"session.followUp",
		"session.removeQueued",
		"session.updateQueued",
		"session.compact",
		"session.respondToTool",
		"git.diffFile",
		"terminal.attach",
	])
		expect(requestMethodDiagnostic(method)).toBe(method);
	for (const method of [
		"packages.install",
		"provider.jbcentralConnect",
		"session.answerQuestion",
		"session.activityList",
	]) {
		expect(requestMethodDiagnostic(method)).toBe("unknown method");
		await expect(handleRequest(method, {}, CTX)).rejects.toThrow("Unknown method");
	}
});

test("question replies bind the saved interaction and apply identical retries once", async () => {
	seedSdkTestModel(dataDir, "handler");
	const question = "Continue with the change?";
	const model = useSdkTestModel([
		modelResponse([
			functionCall(
				"ask_user_question",
				{
					questions: [
						{
							question,
							header: "Continue",
							options: [
								{ label: "Yes", description: "Continue" },
								{ label: "No", description: "Wait" },
							],
						},
					],
				},
				{ callId: "question-call" },
			),
		]),
		modelResponse([assistantMessage("answer received")]),
	]);
	try {
		const workspace = (await handleRequest(
			"workspace.create",
			{ projectId: "p1", name: "Questions" },
			CTX,
		)) as Workspace;
		const created = (await handleRequest(
			"session.create",
			{ workspaceId: workspace.id },
			CTX,
		)) as CreateSessionResult;
		const prompt = handleRequest(
			"session.prompt",
			{ sessionId: created.sessionId, text: "Ask before continuing", messageId: "question-input" },
			CTX,
		);
		const deadline = Date.now() + 5000;
		while (
			getSessionState(created.sessionId).needsInput?.kind !== "tool-response" &&
			Date.now() < deadline
		)
			await Bun.sleep(5);
		const pending = getSessionState(created.sessionId).needsInput;
		if (pending?.kind !== "tool-response")
			throw new Error("Question did not reach its durable wait");
		const input = {
			sessionId: created.sessionId,
			toolCallId: pending.toolCallId,
			interactionId: pending.interactionId,
			runId: pending.runId,
			revision: pending.revision,
			response: {
				answers: [{ questionIndex: 0, question, kind: "option", answer: "Yes" }],
				cancelled: false,
			},
		};
		await expect(
			handleRequest("session.respondToTool", { ...input, runId: "different-run" }, CTX),
		).rejects.toThrow();
		await expect(
			handleRequest("session.respondToTool", { ...input, sessionId: "another-session" }, CTX),
		).rejects.toThrow();
		await expect(
			handleRequest("session.respondToTool", { ...input, toolCallId: "different-call" }, CTX),
		).rejects.toThrow();
		await expect(
			handleRequest("session.respondToTool", { ...input, revision: pending.revision + 1 }, CTX),
		).rejects.toThrow();
		expect(model.calls).toHaveLength(1);
		expect(await handleRequest("session.respondToTool", input, CTX)).toEqual({ ok: true });
		expect(await handleRequest("session.respondToTool", input, CTX)).toEqual({ ok: true });
		await expect(
			handleRequest(
				"session.respondToTool",
				{
					...input,
					response: {
						...input.response,
						answers: [{ ...input.response.answers[0], answer: "No" }],
					},
				},
				CTX,
			),
		).rejects.toThrow("Conflicting");
		while (
			getSessionState(created.sessionId).completion?.outcome !== "succeeded" &&
			Date.now() < deadline
		)
			await Bun.sleep(5);
		expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
		await prompt;
		expect(model.calls).toHaveLength(2);
		disposeAllSessions();
		expect(await handleRequest("session.respondToTool", input, CTX)).toEqual({ ok: true });
		expect(model.calls).toHaveLength(2);
		model.assertComplete();
	} finally {
		disposeAllSessions();
		configureAgentModelFactory();
	}
});
test("approval receipts replay before client hydration after restart without repeating effects", async () => {
	seedSdkTestModel(dataDir, "handler");
	const model = useSdkTestModel([
		modelResponse([
			functionCall(
				"bash",
				{ command: "printf once >> receipt.txt", timeoutMs: 10000 },
				{ callId: "durable-effect" },
			),
		]),
		modelResponse([assistantMessage("done")]),
	]);
	let capture: (request: ExtUiRequest) => void = () => {};
	const approval = new Promise<ExtUiRequest>((resolveApproval) => {
		capture = resolveApproval;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") capture(request);
	});
	try {
		const workspace = (await handleRequest(
			"workspace.create",
			{ projectId: "p1", name: "Receipt replay" },
			CTX,
		)) as Workspace;
		const created = (await handleRequest(
			"session.create",
			{ workspaceId: workspace.id },
			CTX,
		)) as CreateSessionResult;
		const prompt = handleRequest(
			"session.prompt",
			{ sessionId: created.sessionId, text: "Run the command once", messageId: "receipt-input" },
			CTX,
		);
		const request = await approval;
		if (
			request.kind !== "confirm" ||
			!request.runId ||
			!request.toolCallId ||
			request.revision === undefined
		)
			throw new Error("Missing approval identity");
		const response: ExtUiResponse = {
			id: request.id,
			sessionId: created.sessionId,
			runId: request.runId,
			toolCallId: request.toolCallId,
			revision: request.revision,
			value: true,
		};
		expect(await handleRequest("session.extUiReply", { response }, CTX)).toEqual({ ok: true });
		const deadline = Date.now() + 5000;
		while (getSessionState(created.sessionId).execution !== "idle") {
			if (Date.now() > deadline) throw new Error("Approved run did not settle");
			await Bun.sleep(5);
		}
		expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
		await prompt;
		disposeAllSessions();
		expect(await handleRequest("session.extUiReply", { response }, CTX)).toEqual({ ok: true });
		expect(readFileSync(join(workspace.worktreePath, "receipt.txt"), "utf8")).toBe("once");
		expect(model.calls).toHaveLength(2);
		await expect(
			handleRequest("session.extUiReply", { response: { ...response, value: false } }, CTX),
		).rejects.toThrow("Conflicting");
		await closeWorkspaceSessions(workspace.id, async () => {
			await expect(handleRequest("session.extUiReply", { response }, CTX)).rejects.toThrow(
				"unavailable",
			);
		});
		const record = readSessionRecord(created.sessionId);
		if (!record) throw new Error("Missing durable receipt");
		writeFileSync(sessionRecordPath(created.sessionId), JSON.stringify({ ...record, cwd: repo }));
		await expect(handleRequest("session.extUiReply", { response }, CTX)).rejects.toThrow(
			"unavailable",
		);
		writeFileSync(sessionRecordPath(created.sessionId), JSON.stringify(record));
		saveWorkspaces([]);
		await expect(handleRequest("session.extUiReply", { response }, CTX)).rejects.toThrow(
			"Unknown workspace",
		);
		expect(readFileSync(join(workspace.worktreePath, "receipt.txt"), "utf8")).toBe("once");
		model.assertComplete();
	} finally {
		setExtUiPublisher(() => {});
		disposeAllSessions();
		configureAgentModelFactory();
	}
});

test("receipt attachment classifies an unknown effect before considering a resumable checkpoint", async () => {
	seedSdkTestModel(dataDir, "handler");
	const model = useSdkTestModel([modelResponse([assistantMessage("must not run")])]);
	try {
		const workspace = (await handleRequest(
			"workspace.create",
			{ projectId: "p1", name: "Unknown effect" },
			CTX,
		)) as Workspace;
		const created = (await handleRequest(
			"session.create",
			{ workspaceId: workspace.id },
			CTX,
		)) as CreateSessionResult;
		const record = readSessionRecord(created.sessionId);
		if (!record) throw new Error("Missing session record");
		record.state.execution = "running";
		record.state.runId = "interrupted-run";
		record.decisions.receipt = {
			runId: "interrupted-run",
			revision: 10,
			toolCallId: "approved-call",
			value: true,
		};
		record.effects.unknown = {
			runId: "interrupted-run",
			name: "bash",
			arguments: { command: "printf forbidden > replay.marker", timeoutMs: 10000 },
			status: "started",
		};
		record.runCheckpoint = {
			runId: "interrupted-run",
			checkpoint: "must not be deserialized while an effect is unknown",
			granted: true,
			enabledExtensions: [],
		};
		writeFileSync(sessionRecordPath(created.sessionId), JSON.stringify(record));
		disposeAllSessions();
		expect(
			await handleRequest(
				"session.extUiReply",
				{
					response: {
						id: "receipt",
						sessionId: created.sessionId,
						runId: "interrupted-run",
						revision: 10,
						toolCallId: "approved-call",
						value: true,
					},
				},
				CTX,
			),
		).toEqual({ ok: true });
		expect(getSessionState(created.sessionId).completion?.outcome).toBe("interrupted");
		expect(readSessionRecord(created.sessionId)?.effects.unknown?.status).toBe("unknown");
		expect(model.calls).toHaveLength(0);
		expect(existsSync(join(workspace.worktreePath, "replay.marker"))).toBe(false);
	} finally {
		disposeAllSessions();
		configureAgentModelFactory();
	}
});

test("clone handlers resolve the destination and return an opened local project", async () => {
	const input = {
		operationId: "clone-handler",
		url: pathToFileURL(repo).href,
		parentPath: dataDir,
		name: "cloned",
	};
	const destination = (await handleRequest("project.cloneDestination", input, CTX)) as {
		path: string;
	};
	const project = (await handleRequest("project.clone", input, CTX)) as Project;
	expect(project.path).toBe(destination.path);
	expect(gitText(project.path, "rev-parse", "HEAD")).toBe(gitText(repo, "rev-parse", "HEAD"));
	expect(
		await handleRequest("project.cancelClone", { operationId: input.operationId }, CTX),
	).toEqual({ ok: true });
});

test("open-review cache reuse is opt-in so older clients remain fresh", () => {
	expect(shouldRefreshOpenReview(undefined)).toBe(true);
	expect(shouldRefreshOpenReview(false)).toBe(true);
	expect(shouldRefreshOpenReview(true)).toBe(false);
});

test("a client older than the settled protocol never hears about a merged or closed review", () => {
	const merged = { kind: "pull-request", number: 9, state: "merged" } as const;
	const open = { kind: "pull-request", number: 10, state: "open" } as const;
	const stateless = { kind: "pull-request", number: 11 } as const;
	expect(openReviewForClient(merged, WORKSPACE_SETTLE_PROTOCOL_VERSION - 1)).toBeNull();
	expect(openReviewForClient(open, WORKSPACE_SETTLE_PROTOCOL_VERSION - 1)).toBe(open);
	expect(openReviewForClient(stateless, WORKSPACE_SETTLE_PROTOCOL_VERSION - 1)).toBe(stateless);
	expect(openReviewForClient(merged, WORKSPACE_SETTLE_PROTOCOL_VERSION)).toBe(merged);
	expect(openReviewForClient(merged, undefined)).toBe(merged);
	expect(openReviewForClient(null, WORKSPACE_SETTLE_PROTOCOL_VERSION - 1)).toBeNull();
});

test("starting a PR mutation reactivates a parked workspace before any network await", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "PR work" },
		CTX,
	)) as Workspace;
	await handleRequest("workspace.settle", { id: workspace.id }, CTX);

	await expect(
		handleRequest("pr.open", { workspaceId: workspace.id, sessionId: "missing" }, CTX),
	).rejects.toThrow("no 'origin' remote");
	const rows = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
	const after = rows.find((row) => row.id === workspace.id);
	expect(after?.settledOverride).toBeUndefined();
	expect(after?.lastActiveAt ?? 0).toBeGreaterThanOrEqual(workspace.lastActiveAt ?? 0);
});

test("branch status reports a review-free branch, and workspace.push publishes it", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Ship segment" },
		CTX,
	)) as Workspace;
	writeFileSync(join(workspace.worktreePath, "ship.txt"), "ship\n");
	git(workspace.worktreePath, "add", "-A");
	git(workspace.worktreePath, "commit", "-m", "ship");
	writeFileSync(join(workspace.worktreePath, "dirty.txt"), "dirty\n");

	const local = await handleRequest("workspace.branchStatus", { workspaceId: workspace.id }, CTX);
	expect(local).toEqual({
		hasOrigin: false,
		provider: null,
		published: false,
		pushesElsewhere: false,
		aheadOfBase: 1,
		onBase: false,
		review: null,
	});

	const remote = join(dataDir, "origin.git");
	mkdirSync(remote);
	git(remote, "init", "--bare");
	git(repo, "remote", "add", "origin", remote);
	expect(
		await handleRequest(
			"workspace.push",
			{ workspaceId: workspace.id, branch: workspace.branch },
			CTX,
		),
	).toEqual({
		dirtyFiles: 1,
	});
	const published = await handleRequest(
		"workspace.branchStatus",
		{ workspaceId: workspace.id },
		CTX,
	);
	expect(published).toMatchObject({
		hasOrigin: true,
		provider: null,
		published: true,
		ahead: 0,
		behind: 0,
		aheadOfBase: 1,
		review: null,
	});
});

test("branch status measures the branch a managed workspace's terminal switched to", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Switched" },
		CTX,
	)) as Workspace;
	const remote = join(dataDir, "switched.git");
	mkdirSync(remote);
	git(remote, "init", "--bare");
	git(repo, "remote", "add", "origin", remote);
	await handleRequest(
		"workspace.push",
		{ workspaceId: workspace.id, branch: workspace.branch },
		CTX,
	);
	git(workspace.worktreePath, "switch", "-c", "feature/terminal");

	const rows = (await handleRequest(
		"workspace.list",
		{ projectId: "p1", includeDiffStats: false },
		CTX,
	)) as Workspace[];
	expect(rows.find((row) => row.id === workspace.id)).toMatchObject({
		branch: "feature/terminal",
	});
	expect(
		await handleRequest("workspace.branchStatus", { workspaceId: workspace.id }, CTX),
	).toMatchObject({ published: false, review: null });
});

test("a workspace on its base branch gets no review lookup and drops a stored foreign review", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "On base" },
		CTX,
	)) as Workspace;
	git(repo, "remote", "add", "origin", "https://github.com/fake-owner/fake-repo.git");
	const bin = join(dataDir, "bin");
	const ghCalls = join(dataDir, "gh-calls");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ghCalls)}\necho "[]"\n`);
	chmodSync(join(bin, "gh"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
	onTestFinished(() => {
		process.env.PATH = savedPath;
	});
	git(repo, "switch", "-c", "elsewhere");
	git(workspace.worktreePath, "switch", "main");
	await handleRequest("workspace.list", { projectId: "p1", includeDiffStats: false }, CTX);
	setWorkspaceReview(
		workspace.id,
		{ kind: "pull-request", number: 501, state: "merged", url: "https://example.test/501" },
		"main",
	);

	expect(
		await handleRequest(
			"workspace.branchStatus",
			{ workspaceId: workspace.id, skipFetch: true },
			CTX,
		),
	).toMatchObject({ onBase: true, review: null });
	expect(getWorkspace(workspace.id)).toMatchObject({ branch: "main" });
	expect(getWorkspace(workspace.id).review).toBeUndefined();

	setWorkspaceReview(workspace.id, { kind: "pull-request", number: 501, state: "open" }, "main");
	expect(
		await handleRequest(
			"workspace.openReview",
			{ workspaceId: workspace.id, allowCached: true },
			CTX,
		),
	).toBeNull();
	expect(getWorkspace(workspace.id).review).toBeUndefined();
	expect(existsSync(ghCalls)).toBe(false);
});

test("a CI poll re-reads the review without fetching origin; a focus read still fetches", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Poll" },
		CTX,
	)) as Workspace;
	const remote = join(dataDir, "poll.git");
	mkdirSync(remote);
	git(remote, "init", "--bare");
	git(repo, "remote", "add", "origin", remote);
	await handleRequest(
		"workspace.push",
		{ workspaceId: workspace.id, branch: workspace.branch },
		CTX,
	);
	const other = join(dataDir, "poll-other");
	git(dataDir, "clone", "--branch", workspace.branch, remote, other);
	git(other, "config", "user.email", "t@thinkrail.test");
	git(other, "config", "user.name", "test");
	writeFileSync(join(other, "teammate.txt"), "teammate\n");
	git(other, "add", "-A");
	git(other, "commit", "-m", "teammate");
	git(other, "push", "origin", workspace.branch);

	expect(
		await handleRequest(
			"workspace.branchStatus",
			{ workspaceId: workspace.id, skipFetch: true },
			CTX,
		),
	).toMatchObject({ published: true, behind: 0 });
	expect(
		await handleRequest("workspace.branchStatus", { workspaceId: workspace.id }, CTX),
	).toMatchObject({ published: true, behind: 1 });
});

test("a split origin measures the branch against where it is pushed, not where it is fetched", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Split origin" },
		CTX,
	)) as Workspace;
	writeFileSync(join(workspace.worktreePath, "ship.txt"), "ship\n");
	git(workspace.worktreePath, "add", "-A");
	git(workspace.worktreePath, "commit", "-m", "ship");
	const fetchRepo = join(dataDir, "fetch.git");
	const pushRepo = join(dataDir, "push.git");
	for (const bare of [fetchRepo, pushRepo]) {
		mkdirSync(bare);
		git(bare, "init", "--bare");
	}
	git(repo, "remote", "add", "origin", fetchRepo);
	git(repo, "remote", "set-url", "--push", "origin", pushRepo);
	git(repo, "push", fetchRepo, "main");
	await handleRequest(
		"workspace.push",
		{ workspaceId: workspace.id, branch: workspace.branch },
		CTX,
	);

	const other = join(dataDir, "other");
	git(dataDir, "clone", fetchRepo, other);
	git(other, "config", "user.email", "t@thinkrail.test");
	git(other, "config", "user.name", "test");
	git(other, "switch", "-c", workspace.branch);
	writeFileSync(join(other, "unrelated.txt"), "unrelated\n");
	git(other, "add", "-A");
	git(other, "commit", "-m", "unrelated on the fetch side");
	git(other, "push", "origin", workspace.branch);
	git(workspace.worktreePath, "fetch", "origin");
	git(other, "push", "origin", "--delete", workspace.branch);

	expect(
		await handleRequest("workspace.branchStatus", { workspaceId: workspace.id }, CTX),
	).toMatchObject({ published: true, pushesElsewhere: true, ahead: 0, behind: 0 });

	const pushed = join(dataDir, "pushed");
	git(dataDir, "clone", "--branch", workspace.branch, pushRepo, pushed);
	git(pushed, "config", "user.email", "t@thinkrail.test");
	git(pushed, "config", "user.name", "test");
	writeFileSync(join(pushed, "later.txt"), "later\n");
	git(pushed, "add", "-A");
	git(pushed, "commit", "-m", "later on the push side");
	git(pushed, "push", "origin", workspace.branch);

	git(workspace.worktreePath, "fetch", "--prune", "origin");

	expect(
		await handleRequest(
			"workspace.branchStatus",
			{ workspaceId: workspace.id, allowCached: true },
			CTX,
		),
	).toMatchObject({ published: true, ahead: 0, behind: 1 });
});

test("a split origin whose push repository can't be read reports publication as unknown", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Unreachable push" },
		CTX,
	)) as Workspace;
	const fetchRepo = join(dataDir, "fetch-only.git");
	mkdirSync(fetchRepo);
	git(fetchRepo, "init", "--bare");
	git(repo, "remote", "add", "origin", fetchRepo);
	git(workspace.worktreePath, "push", fetchRepo, `HEAD:refs/heads/${workspace.branch}`);
	git(workspace.worktreePath, "fetch", "origin");
	git(repo, "remote", "set-url", "--push", "origin", join(dataDir, "missing.git"));

	const status = await handleRequest("workspace.branchStatus", { workspaceId: workspace.id }, CTX);
	expect(status).toMatchObject({ hasOrigin: true, pushesElsewhere: true, published: null });
	expect(status).not.toHaveProperty("ahead");
});

test("a pre-v87 client's source-less PR preview keeps the session's plan body", async () => {
	const workspace = (await handleRequest(
		"workspace.create",
		{ projectId: "p1", name: "Legacy preview" },
		CTX,
	)) as Workspace;
	writeFileSync(join(workspace.worktreePath, "ship.txt"), "ship\n");
	git(workspace.worktreePath, "add", "-A");
	git(workspace.worktreePath, "commit", "-m", "ship it");
	const params = { workspaceId: workspace.id, sessionId: "legacy-session" };

	const legacy = (await handleRequest("pr.preview", params, {
		...CTX,
		protocolVersion: BRANCH_STATUS_PROTOCOL_VERSION - 1,
	})) as { body: string };
	expect(legacy.body).toContain("## Committed outside the plan");
	const current = (await handleRequest("pr.preview", params, CTX)) as {
		body: string;
		source: string;
	};
	expect(current).toMatchObject({ source: "commits", body: "- ship it" });
});

test("request diagnostics expose only registered method names", async () => {
	expect(requestMethodDiagnostic("workspace.list")).toBe("workspace.list");
	expect(requestMethodDiagnostic("host.update")).toBe("host.update");
	expect(requestMethodDiagnostic("secret prompt value")).toBe("unknown method");
	expect(requestMethodDiagnostic("toString")).toBe("unknown method");
	await expect(handleRequest("toString", undefined, CTX)).rejects.toThrow("Unknown method");
});

test("host.update invokes only the context-injected parameterless operation", async () => {
	let runs = 0;
	expect(
		await handleRequest(
			"host.update",
			{ command: "private-command", version: "99.0.0" },
			{ clientKey: "test-client", runHostUpdate: () => runs++ },
		),
	).toEqual({ ok: true });
	expect(runs).toBe(1);
	await expect(handleRequest("host.update", {}, CTX)).rejects.toThrow(
		"Host update is unavailable.",
	);
});

test("template reads resolve a project's current checkout and reject ambiguous locations", async () => {
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const templateRoot = dataDir;

	try {
		const globalDir = join(templateRoot, "prompts");
		const projectDir = join(repo, ".raildesign", "prompts");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(globalDir, "kickoff.md"), "global body");
		writeFileSync(join(projectDir, "kickoff.md"), "project body");

		const listed = (await handleRequest("template.list", { projectId: "p1" }, CTX)) as {
			templates: TemplateInfo[];
		};
		expect(listed.templates).toContainEqual(
			expect.objectContaining({ name: "kickoff", scope: "project" }),
		);

		const template = (await handleRequest(
			"template.get",
			{ projectId: "p1", name: "kickoff" },
			CTX,
		)) as Template;
		expect(template).toMatchObject({ scope: "project", content: "project body" });

		await expect(
			handleRequest("template.list", { workspaceId: "unused", projectId: "p1" }, CTX),
		).rejects.toThrow("either workspaceId or projectId");
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});

test("a background create hands the finished workspace a terminal and the held chat", async () => {
	const cleanup = await setupDefaultModel();
	const removed: WorkspaceCreationRemoved[] = [];
	setWorkspaceCreationPublisher((event) => {
		if (event.kind === "removed") removed.push(event.removed);
	});
	setWorkspaceCreationHandoff(workspaceCreationHandoff);
	try {
		const models = (await handleRequest("model.list", {}, CTX)) as WireModel[];
		const selected = models.find((model) => model.provider === "handler");
		if (!selected) throw new Error("handler test model was not available");
		useSdkTestModel([
			modelResponder(async () => {
				await Bun.sleep(4000);
				return [assistantMessage("done")];
			}),
		]);
		const started = Date.now();
		const creation = (await handleRequest(
			"workspace.startCreate",
			{ projectId: "p1", kickoff: { text: "Start here", model: selected } },
			CTX,
		)) as WorkspaceCreation;
		expect(creation).toMatchObject({ state: "running", kickoff: { text: "Start here" } });
		const workspace = await awaitWorkspaceCreation(creation.id);
		expect(Date.now() - started).toBeLessThan(3_000);

		expect(workspace.initialTerminalPending).toBeUndefined();
		expect(removed).toHaveLength(1);
		expect(removed[0]).toMatchObject({ id: creation.id, workspace: { id: creation.id } });
		expect(removed[0]?.sessionId).toEqual(expect.any(String));
		expect(await handleRequest("workspace.listCreations", {}, CTX)).toEqual([]);
	} finally {
		setWorkspaceCreationHandoff(null);
		setWorkspaceCreationPublisher(null);
		disposeAllSessions();
		cleanup();
	}
});

test("model.default and new session creation share the AppConfig default resolution", async () => {
	const cleanup = await setupDefaultModel();
	try {
		const models = (await handleRequest("model.list", {}, CTX)) as WireModel[];
		const selected = models.find((model) => model.provider === "handler");
		if (!selected) throw new Error("handler test model was not available");
		await handleRequest(
			"settings.update",
			{ config: { defaultModel: selected, defaultEffort: "high" } },
			CTX,
		);
		const resolved = (await handleRequest("model.default", {}, CTX)) as {
			model: WireModel | null;
			thinkingLevel: string;
		};
		expect(resolved).toEqual({ model: selected, thinkingLevel: "off" });

		const workspace = (await handleRequest(
			"workspace.create",
			{ projectId: "p1" },
			CTX,
		)) as Workspace;
		const created = (await handleRequest(
			"session.create",
			{ workspaceId: workspace.id },
			CTX,
		)) as CreateSessionResult;
		expect(created).toMatchObject({ model: selected, thinkingLevel: "off" });
	} finally {
		disposeAllSessions();
		cleanup();
	}
});

test("settings.update merges extension settings per key and rejects a malformed value", async () => {
	await handleRequest(
		"settings.update",
		{ config: { extensionSettings: { "ask-user-question": { richPreviews: false } } } },
		CTX,
	);
	const config = (await handleRequest(
		"settings.update",
		{ config: { extensionSettings: { "ask-user-question": { other: true } } } },
		CTX,
	)) as AppConfig;
	expect(config.extensionSettings["ask-user-question"]).toEqual({
		richPreviews: false,
		other: true,
	});
	await expect(
		handleRequest(
			"settings.update",
			{ config: { extensionSettings: { "ask-user-question": { richPreviews: "no" } } } } as never,
			CTX,
		),
	).rejects.toThrow("extensionSettings must map extension names to boolean settings");
});

test("extension.list reflects disabledExtensions written through settings.update", async () => {
	expect(await handleRequest("extension.list", {}, CTX)).toEqual([
		{
			name: "visualize",
			title: "Visualize",
			description: expect.any(String),
			enabled: true,
			tools: ["visualize"],
			hasChildExtensions: false,
		},
		{
			name: "ask-user-question",
			title: "Ask user question",
			description: expect.any(String),
			enabled: true,
			tools: ["ask_user_question"],
			hasChildExtensions: false,
			settings: [{ key: "richPreviews", default: true }],
		},
		{
			name: "web-access",
			title: "Web access",
			description: expect.any(String),
			enabled: true,
			tools: ["web_search", "web_fetch"],
			hasChildExtensions: true,
		},
	]);
	await handleRequest(
		"settings.update",
		{ config: { disabledExtensions: ["visualize", "web-access", "retired"] } },
		CTX,
	);
	expect(await handleRequest("extension.list", {}, CTX)).toMatchObject([
		{ name: "visualize", enabled: false },
		{ name: "ask-user-question", enabled: true },
		{ name: "web-access", enabled: false },
	]);
	await handleRequest("settings.update", { config: { disabledExtensions: [] } }, CTX);
	expect(await handleRequest("extension.list", {}, CTX)).toMatchObject([
		{ name: "visualize", enabled: true },
		{ name: "ask-user-question", enabled: true },
		{ name: "web-access", enabled: true },
	]);
});

test("workspace.rename locks the display name without changing Git or the worktree path", async () => {
	const created = (await handleRequest("workspace.create", { projectId: "p1" }, CTX)) as Workspace;

	const renamed = (await handleRequest(
		"workspace.rename",
		{ id: created.id, name: "Manual Workspace Name" },
		CTX,
	)) as Workspace;

	expect(renamed).toMatchObject({
		id: created.id,
		name: "Manual Workspace Name",
		branch: created.branch,
		renamed: true,
		worktreePath: created.worktreePath,
	});
	expect(gitText(created.worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
	const listed = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
	expect(listed.find((workspace) => workspace.id === created.id)).toMatchObject(renamed);
});

test("session.rename persists a bounded title into a closed application transcript", async () => {
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(dataDir, "rename-agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const rows = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
		const workspace = rows[0];
		if (!workspace) throw new Error("expected a workspace");
		const fixture = writeFixtureSession(sessionDirFor(dataDir), {
			cwd: workspace.worktreePath,
			workspaceId: workspace.id,
			name: "Before rename",
			messages: [{ role: "user", text: "hello", timestamp: Date.now() }],
		});

		expect(
			await handleRequest(
				"session.rename",
				{ workspaceId: workspace.id, sessionId: fixture.id, title: "  After\r\nrename  " },
				CTX,
			),
		).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(fixture.path, "utf8")).title).toBe("After rename");
		await expect(
			handleRequest(
				"session.rename",
				{ workspaceId: workspace.id, sessionId: fixture.id, title: " \n " },
				CTX,
			),
		).rejects.toThrow("Invalid session title");
		await expect(
			handleRequest(
				"session.rename",
				{ workspaceId: workspace.id, sessionId: fixture.id, title: "x".repeat(81) },
				CTX,
			),
		).rejects.toThrow("Invalid session title");
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});

test("workspace.watchReady waits for startup once, then reports an already-ready watcher", async () => {
	const rows = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
	const workspace = rows[0];
	if (!workspace) throw new Error("expected a workspace");

	const first = (await handleRequest(
		"workspace.watchReady",
		{ workspaceId: workspace.id },
		CTX,
	)) as WorkspaceWatchReadyResult;
	expect(first).toEqual({ startupNudge: true });
	const second = (await handleRequest(
		"workspace.watchReady",
		{ workspaceId: workspace.id },
		CTX,
	)) as WorkspaceWatchReadyResult;
	expect(second).toEqual({ startupNudge: false });
});

test("a review send that names its chat lands every file's drafts there as one package", async () => {
	const cleanup = await setupDefaultModel();
	try {
		const rows = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
		const workspace = rows[0];
		if (!workspace) throw new Error("expected a workspace");
		writeFileSync(join(repo, "NOTES.md"), "notes\n");
		const chat = (await handleRequest(
			"session.create",
			{ workspaceId: workspace.id },
			CTX,
		)) as CreateSessionResult;
		const draft = (path: string) =>
			addComment({
				workspaceId: workspace.id,
				kind: "inline",
				anchor: {
					path,
					side: "worktree",
					contentHash: "",
					selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }],
				},
				body: `about ${path}`,
			});
		const ids = [(await draft("README.md")).id, (await draft("NOTES.md")).id];

		const sent = (await handleRequest(
			"review.sendBatch",
			{ workspaceId: workspace.id, sessionId: chat.sessionId },
			CTX,
		)) as { sessions: { sessionId: string }[] };

		expect(sent.sessions.map((session) => session.sessionId)).toEqual([chat.sessionId]);
		const comments = (await getReviewSnapshot(workspace.id)).comments.filter((comment) =>
			ids.includes(comment.id),
		);
		expect(comments.map((comment) => [comment.status, comment.sessionId])).toEqual([
			["sent", chat.sessionId],
			["sent", chat.sessionId],
		]);
	} finally {
		disposeAllSessions();
		cleanup();
	}
});

test("workspace mutation handlers reject the Default before any side effect", async () => {
	const rows = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
	const def = rows[0];
	if (def?.kind !== "default")
		throw new Error("expected the ensured Default workspace pinned first");

	await expect(handleRequest("workspace.remove", { id: def.id }, CTX)).rejects.toThrow(
		"The Default workspace cannot be removed",
	);
	await expect(
		handleRequest("workspace.rename", { id: def.id, name: "Not Default" }, CTX),
	).rejects.toThrow("The Default workspace cannot be renamed");

	const after = (await handleRequest("workspace.list", { projectId: "p1" }, CTX)) as Workspace[];
	expect(after.filter((w) => w.kind === "default")).toHaveLength(1);
	expect(after[0]?.id).toBe(def.id);
});

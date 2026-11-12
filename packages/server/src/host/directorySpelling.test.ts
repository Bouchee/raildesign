import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import type { HistoryScope, Workspace } from "@thinkrail/contracts";
import {
	configureAgentModelFactory,
	createSession,
	deleteSession,
	disposeAllSessions,
	ensureSessionAttached,
	getSessionMessages,
	listSessions,
	promptSession,
	removeSession,
	renameSession,
	sessionRecordPath,
	settleSessionsForShutdown,
} from "../agent";
import { HistoryIndex } from "../history";
import { listProjects, openProject } from "../projects";
import { setTrashImplementationForTests } from "../trash";
import {
	getWorkspace,
	listWorkspaceRecords,
	listWorkspaces,
	openExistingWorktree,
} from "../workspaces";
import { buildHistoryScope } from "./historyScope";
import { seedSdkTestModel, useSdkTestModel } from "./sdkTestFixture";

const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	data: process.env.THINKRAIL_DATA_DIR,
	offline: process.env.PI_OFFLINE,
};
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-dir-spelling-")));
const agentDir = join(root, "agent");
const trashed: string[] = [];

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function gitRepo(name: string): string {
	const repo = join(root, name);
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@thinkrail.test");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	return repo;
}

function transcriptOf(sessionId: string): string {
	return sessionRecordPath(sessionId);
}
function headerCwd(sessionId: string): string {
	return JSON.parse(readFileSync(transcriptOf(sessionId), "utf8")).cwd;
}

async function chat(workspace: Workspace, text: string): Promise<string> {
	const { sessionId } = await createSession({
		workspaceId: workspace.id,
		cwd: workspace.worktreePath,
	});
	useSdkTestModel([modelResponse([assistantMessage(`reply to ${text}`)])]);
	await promptSession(sessionId, text);
	return sessionId;
}

async function search(query: string, scope: HistoryScope) {
	const index = new HistoryIndex();
	const { filter, labels } = buildHistoryScope(scope, listProjects(), listWorkspaceRecords);
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = await index.search({ query, filter, labels });
		if (!result.indexing) return result;
		await Bun.sleep(20);
	}
	throw new Error("history index never settled");
}

async function expectFullChatLifecycle(workspace: Workspace): Promise<void> {
	expect(workspace.worktreePath).toBe(resolve(workspace.worktreePath));
	const cwd = workspace.worktreePath;

	const live = await chat(workspace, `live ${workspace.kind}`);
	await expect(getSessionMessages(live, workspace.id, cwd)).resolves.toMatchObject({
		summary: { sessionId: live },
	});
	const liveTranscript = transcriptOf(live);
	await deleteSession(live, workspace.id, cwd);
	expect(existsSync(liveTranscript)).toBe(false);

	const marker = `closedchat${workspace.kind}`;
	const closed = await chat(workspace, marker);
	const closedCwd = headerCwd(closed);
	await removeSession(closed);
	expect((await listSessions(workspace.id, cwd)).map((s) => s.sessionId)).toContain(closed);
	await renameSession(closed, workspace.id, cwd, "Renamed on disk");
	expect((await getSessionMessages(closed, workspace.id, cwd)).summary.title).toBe(
		"Renamed on disk",
	);
	expect(await ensureSessionAttached(closed, workspace.id, cwd)).toBe(true);
	await removeSession(closed);

	for (const scope of [
		{ kind: "workspace", workspaceId: workspace.id },
		{ kind: "project", projectId: workspace.projectId },
	] as const) {
		const hits = await search(marker, scope);
		expect(hits.prompts.map((hit) => [hit.sessionId, hit.workspaceId, hit.projectId])).toEqual([
			[closed, workspace.id, workspace.projectId],
		]);
		expect(hits.prompts[0]?.cwd).toBe(closedCwd);
	}

	const closedTranscript = transcriptOf(closed);
	const trashedBefore = trashed.length;
	await deleteSession(closed, workspace.id, cwd);
	expect(trashed.length).toBe(trashedBefore + 1);
	expect(existsSync(closedTranscript)).toBe(false);
}

beforeAll(async () => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_OFFLINE = "1";
	seedSdkTestModel(join(root, "data"), "spelling");
	configureAgentModelFactory(
		() => new ScriptedModel([modelResponse([assistantMessage("fixture reply")])]),
	);
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input) {
			trashed.push(path);
			rmSync(path, { force: true });
		}
	});
});

afterAll(async () => {
	setTrashImplementationForTests(undefined);
	await settleSessionsForShutdown();
	disposeAllSessions();
	configureAgentModelFactory();
	if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.agent;
	if (saved.data === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = saved.data;
	if (saved.offline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = saved.offline;
	rmSync(root, { recursive: true, force: true });
});

test("a chat in a project's Default workspace lives its whole lifecycle", async () => {
	const project = openProject(gitRepo("default-repo"));
	const workspace = (await listWorkspaces(project.id)).find((w) => w.kind === "default");
	if (!workspace) throw new Error("Default workspace is missing");
	await expectFullChatLifecycle(workspace);
}, 30_000);

test("a chat in an attached existing worktree lives its whole lifecycle", async () => {
	const repo = gitRepo("external-repo");
	const checkout = join(root, "external checkout");
	git(repo, "worktree", "add", "-b", "feature/external", checkout);
	const project = openProject(repo);
	const workspace = await openExistingWorktree(project.id, checkout);
	await expectFullChatLifecycle(workspace);
}, 30_000);

test("chats recorded under a resolved spelling stay reachable when workspace paths normalize", async () => {
	const repo = gitRepo("legacy-repo");
	const project = openProject(repo);
	const workspace = (await listWorkspaces(project.id)).find((w) => w.kind === "default");
	if (!workspace) throw new Error("Default workspace is missing");
	const unresolved = `${workspace.worktreePath}${sep}.`;
	const legacy = await createSession({ workspaceId: workspace.id, cwd: unresolved });
	useSdkTestModel([modelResponse([assistantMessage("legacy reply")])]);
	await promptSession(legacy.sessionId, "legacy chat");
	await removeSession(legacy.sessionId);
	const dataDir = join(root, "data");
	const records = JSON.parse(readFileSync(join(dataDir, "workspaces.json"), "utf8"));
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify(
			records.map((record: Workspace) =>
				record.id === workspace.id ? { ...record, worktreePath: unresolved } : record,
			),
		),
	);

	const healed = getWorkspace(workspace.id);
	expect(healed.worktreePath).toBe(workspace.worktreePath);
	expect((await listSessions(healed.id, healed.worktreePath)).map((s) => s.sessionId)).toContain(
		legacy.sessionId,
	);
	expect(await ensureSessionAttached(legacy.sessionId, healed.id, healed.worktreePath)).toBe(true);
	await deleteSession(legacy.sessionId, healed.id, healed.worktreePath);
	expect(trashed.at(-1)).toContain(legacy.sessionId);
}, 30_000);

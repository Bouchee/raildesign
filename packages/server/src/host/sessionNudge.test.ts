import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import {
	configureAgentModelFactory,
	createSession,
	disposeAllSessions,
	getSessionState,
	getSessionWorkspaceId,
	readSessionRecord,
	removeSession,
} from "../agent";
import { saveWorkspaces } from "../persistence";
import { handleRequest } from "./handlers";
import { seedSdkTestModel } from "./sdkTestFixture";

let root: string;
let cwd: string;
const originalData = process.env.THINKRAIL_DATA_DIR;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sdk-nudge-host-"));
	cwd = join(root, "worktree");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	seedSdkTestModel(process.env.THINKRAIL_DATA_DIR, "custom-nudge");
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Fixture",
			branch: "main",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
});
afterEach(() => {
	disposeAllSessions();
	configureAgentModelFactory();
	if (originalData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = originalData;
	rmSync(root, { recursive: true, force: true });
});

test("nudge RPC restores its owned session before UI hydration and rejects foreign/control-invalid input", async () => {
	const model = new ScriptedModel([modelResponse([assistantMessage("notified")])]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd, workspaceId: "workspace" });
	await removeSession(sessionId);
	expect(getSessionWorkspaceId(sessionId)).toBeUndefined();
	const params = {
		workspaceId: "workspace",
		sessionId,
		messageId: "todo-nudge-fixture",
		text: `${TODO_NUDGE_PREFIX}Read the manual task.`,
	};
	const ctx = { clientKey: "nudge-test" };
	await expect(
		handleRequest("session.nudge", { ...params, workspaceId: "foreign" }, ctx),
	).rejects.toThrow("another workspace");
	await expect(
		handleRequest("session.nudge", { ...params, text: "ordinary user message" }, ctx),
	).rejects.toThrow("internal control");
	expect(model.calls).toHaveLength(0);
	expect(await handleRequest("session.nudge", params, ctx)).toEqual({ disposition: "prompted" });
	for (let attempt = 0; attempt < 100 && getSessionState(sessionId).execution !== "idle"; attempt++)
		await Bun.sleep(10);
	expect(getSessionWorkspaceId(sessionId)).toBe("workspace");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	await removeSession(sessionId);
	await handleRequest("session.nudge", params, ctx);
	expect(model.calls).toHaveLength(1);
	expect(
		readSessionRecord(sessionId)?.messages.filter((message) => message.role === "user"),
	).toEqual([]);
	model.assertComplete();
});

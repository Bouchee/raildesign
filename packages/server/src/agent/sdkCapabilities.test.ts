import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import { loadWorkspaces, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	promptSession,
	reloadSessionResources,
	removeSession,
	setExtUiPublisher,
} from "./sdkSessionManager";
import { readSessionRecord } from "./sessionStore";

const previous = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
	OPENAI_MODEL: process.env.OPENAI_MODEL,
	HOME: process.env.HOME,
};
let root: string;
let cwd: string;
let sessionId: string;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sdk-capabilities-"));
	cwd = join(root, "workspace");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.HOME = join(root, "home");
	mkdirSync(process.env.THINKRAIL_DATA_DIR);
	mkdirSync(process.env.HOME);
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "offline-test-key";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "main",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	({ sessionId } = await createSession({ workspaceId: "workspace", cwd }));
});
afterEach(async () => {
	disposeAllSessions();
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
const done = () => modelResponse([assistantMessage("done")]);
const call = (name: string, args: Record<string, unknown>, callId: string) =>
	modelResponse([functionCall(name, args, { callId })]);
test("the session manager supplies workspace instructions and executes admitted Skill search and reads", async () => {
	const skill = join(root, "data/skills/fixture");
	mkdirSync(skill, { recursive: true });
	writeFileSync(
		join(skill, "SKILL.md"),
		"---\nname: fixture\ndescription: Capability fixture instructions\n---\nUse the fixture procedure.",
	);
	writeFileSync(join(cwd, "AGENTS.md"), "Keep fixture changes inside this workspace.");
	const model = new ScriptedModel([
		call("skill_search", { query: "Capability fixture", limit: null }, "find-skill"),
		call("skill_read", { name: "fixture", path: null }, "read-skill"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	await promptSession(sessionId, "Find and read the fixture Skill.");
	const messages = (await getSessionMessages(sessionId, "workspace", cwd)).messages;
	const result = messages.find(
		(item) => item.role === "toolResult" && item.toolCallId === "read-skill",
	);
	expect(result?.role === "toolResult" && result.isError).toBe(false);
	expect(JSON.stringify(result)).toContain("Use the fixture procedure.");
	expect(JSON.stringify(model.calls[0]?.request)).toContain(
		"Keep fixture changes inside this workspace.",
	);
	expect(readSessionRecord(sessionId)?.effects["read-skill"]?.status).toBe("completed");
});

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for fixture");
		await Bun.sleep(5);
	}
}
test("idle resource reload validates fresh resources without a model call and refuses pending recovery", async () => {
	const model = new ScriptedModel([
		call("bash", { command: "true", timeoutMs: 1000 }, "reload-bash"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory(() => model);
	writeFileSync(join(cwd, "AGENTS.md"), "Current workspace rules");
	await reloadSessionResources(created.sessionId, "workspace", cwd);
	expect(model.calls).toHaveLength(0);
	await expect(reloadSessionResources(created.sessionId, "foreign", cwd)).rejects.toThrow(
		"unavailable",
	);
	writeFileSync(join(cwd, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
	await expect(reloadSessionResources(created.sessionId, "workspace", cwd)).rejects.toThrow(
		"128 KiB",
	);
	writeFileSync(join(cwd, "AGENTS.md"), "Repaired rules");
	await reloadSessionResources(created.sessionId, "workspace", cwd);
	setExtUiPublisher(() => {});
	const running = promptSession(created.sessionId, "Run the check");
	await until(() => getSessionState(created.sessionId).needsInput?.kind === "dialog");
	await expect(reloadSessionResources(created.sessionId, "workspace", cwd)).rejects.toThrow("idle");
	await removeSession(created.sessionId);
	await running;
	await expect(reloadSessionResources(created.sessionId, "workspace", cwd)).rejects.toThrow("idle");
	expect(model.calls).toHaveLength(1);
});

test("manual-only Skill commands expand under the run grant and rejected commands leave the session idle", async () => {
	const directory = join(root, "data/skills/manual");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		"---\nname: manual\ndescription: Manual fixture\ndisable-model-invocation: true\n---\nManual fixture procedure.",
	);
	writeFileSync(join(directory, "reference.txt"), "Manual resource content");
	const model = new ScriptedModel([
		call("skill_read", { name: "manual", path: "reference.txt" }, "manual-resource"),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	await promptSession(sessionId, "/skill:manual check files", undefined, "manual-command");
	expect(JSON.stringify(model.calls[0]?.request)).toContain("Manual fixture procedure.");
	expect(JSON.stringify(readSessionRecord(sessionId)?.messages)).toContain(
		"Manual resource content",
	);
	expect(
		readSessionRecord(sessionId)?.messages.filter((message) => message.id === "manual-command"),
	).toHaveLength(1);
	saveWorkspaces(
		loadWorkspaces().map((workspace) => ({ ...workspace, skillOverrides: { manual: "off" } })),
	);
	expect(() => promptSession(sessionId, "/skill:manual denied")).toThrow("not approved");
	expect(getSessionState(sessionId).execution).toBe("idle");
	await promptSession(sessionId, "Continue normally");
	expect(model.calls).toHaveLength(3);
});

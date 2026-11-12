import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, functionCall, modelResponse } from "@openai/agents/testing";
import {
	configureAgentModelFactory,
	createSession,
	disposeAllSessions,
	getSessionMessages,
	promptSession,
} from "../agent";
import { saveWorkspaces } from "../persistence";
import { seedSdkTestModel, useSdkTestModel } from "./sdkTestFixture";

let root: string;
let worktree: string;
const saved = { data: process.env.THINKRAIL_DATA_DIR, path: process.env.PATH };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-search-test-"));
	worktree = join(root, "worktree");
	mkdirSync(worktree);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	seedSdkTestModel(process.env.THINKRAIL_DATA_DIR, "search-test");
	const initialized = Bun.spawnSync(["git", "init", worktree], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if (!initialized.success) throw new Error("Search fixture repository failed");
	saveWorkspaces([
		{
			id: "search",
			projectId: "project",
			name: "Search",
			branch: "main",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
});

afterEach(() => {
	disposeAllSessions();
	configureAgentModelFactory();
	for (const [key, value] of Object.entries({ THINKRAIL_DATA_DIR: saved.data, PATH: saved.path })) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

async function search(query: string): Promise<{ text: string; isError: boolean }> {
	useSdkTestModel([
		modelResponse([functionCall("search", { query }, { callId: "search-call" })]),
		modelResponse([assistantMessage("done")]),
	]);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "search" });
	await promptSession(sessionId, query);
	const snapshot = await getSessionMessages(sessionId, "search", worktree);
	const result = snapshot.messages.find((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") throw new Error("Search produced no actual tool result");
	return {
		text: result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
		isError: result.isError,
	};
}

test("search finds tracked and untracked literal text and excludes ignored files, Git metadata and outside symlinks", async () => {
	const needle = "literal[brackets]";
	writeFileSync(join(worktree, "tracked.txt"), `${needle}\n`);
	writeFileSync(join(worktree, ".gitignore"), "ignored.txt\n");
	const tracked = Bun.spawnSync(["git", "-C", worktree, "add", "tracked.txt", ".gitignore"], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if (!tracked.success) throw new Error("Search fixture tracking failed");
	writeFileSync(join(worktree, "untracked.txt"), `${needle}\n`);
	writeFileSync(join(worktree, "ignored.txt"), `${needle} ignored-marker\n`);
	writeFileSync(join(worktree, ".git", "fixture"), `${needle} metadata-marker\n`);
	writeFileSync(join(root, "outside.txt"), `${needle} outside-marker\n`);
	symlinkSync(join(root, "outside.txt"), join(worktree, "outside-link.txt"));
	const result = await search(needle);
	expect(result.isError).toBe(false);
	expect(result.text).toContain(`tracked.txt:1:${needle}`);
	expect(result.text).toContain(`untracked.txt:1:${needle}`);
	for (const marker of ["ignored-marker", "metadata-marker", "outside-marker"])
		expect(result.text).not.toContain(marker);
});

test("an actual no-match exit returns an empty successful search", async () => {
	expect(await search("absent literal")).toEqual({ text: "", isError: false });
});

test("a failed search command is an error result rather than successful search text", async () => {
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf 'fixture command failure' >&2\nexit 2\n", {
		mode: 0o755,
	});
	process.env.PATH = bin;
	const result = await search("needle");
	expect(result.isError).toBe(true);
	expect(result.text).toContain("Search failed");
});

test("a capped search reports that its real output is incomplete", async () => {
	writeFileSync(join(worktree, "large.txt"), "needle ".repeat(10000));
	const result = await search("needle");
	expect(result.text).toContain("Search output truncated at 32768 bytes");
	expect(result.text.length).toBeLessThan(33000);
});

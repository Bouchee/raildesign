import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
} from "@openai/agents/testing";
import type { SessionEvent } from "@thinkrail/contracts";
import {
	configureAgentModelFactory,
	createSession,
	getSessionWorkspaceId,
	promptSession,
	removeSession,
	resolveExtUi,
	setExtUiPublisher,
	setSessionPublisher,
} from "../agent";
import * as git from "../git";
import { loadTurns, saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { listTurns, setTurnPublisher, TurnTracker } from "../turns";
import { getWorkspace } from "../workspaces";
import { seedSdkTestModel, useSdkTestModel } from "./sdkTestFixture";
import { createServer, type RunningServer } from "./server";

const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
let directory: string;
let repo: string;
let server: RunningServer | undefined;

function sh(...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
	if (!result.success) throw new Error(result.stderr.toString());
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-turn-shutdown-"));
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	process.env.PI_OFFLINE = "1";
	repo = join(directory, "repo");
	mkdirSync(repo);
	sh("init", "-b", "main");
	sh("config", "user.email", "t@thinkrail.test");
	sh("config", "user.name", "test");
	sh("config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	sh("add", "-A");
	sh("commit", "-m", "init");
	saveWorkspaces([
		{
			id: "w1",
			projectId: "p1",
			kind: "default",
			name: "repo",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
		},
	]);
	resetConfigCache();
	seedSdkTestModel(process.env.THINKRAIL_DATA_DIR, "turn-shutdown");
});

afterEach(async () => {
	await server?.shutdown();
	server = undefined;
	setSessionPublisher(() => {});
	setExtUiPublisher(() => {});
	configureAgentModelFactory();
	setTurnPublisher(() => {});
	resetConfigCache();
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test.each(["removeSession", "shutdown"] as const)(
	"%s preserves a completed prompt's still-recording turn receipt",
	async (teardown) => {
		const baseReady = Promise.withResolvers<void>();
		const releaseHead = Promise.withResolvers<void>();
		const trees: (string | null)[] = [];
		const realSnapshot = git.snapshotWorktree;
		const snapshotSpy = spyOn(git, "snapshotWorktree").mockImplementation(async (cwd) => {
			const tree = await realSnapshot(cwd);
			trees.push(tree);
			if (trees.length === 1) baseReady.resolve();
			else await releaseHead.promise;
			return tree;
		});
		const realObserve = TurnTracker.prototype.observe;
		let recording: Promise<void> | undefined;
		const observeSpy = spyOn(TurnTracker.prototype, "observe").mockImplementation(function (
			this: TurnTracker,
			sessionId: string,
			event: SessionEvent,
		) {
			const job = realObserve.call(this, sessionId, event);
			if (event.type === "agent_settled") recording = job;
			return job;
		});
		try {
			useSdkTestModel([
				modelResponder(async () => {
					await baseReady.promise;
					return [
						functionCall(
							"apply_patch",
							{ path: "feature.ts", diff: "+export const feature = true;\n", original: null },
							{ callId: "write-feature" },
						),
					];
				}),
				modelResponse([assistantMessage("Done")]),
			]);
			server = await createServer({ port: 0 });
			setExtUiPublisher((request) => {
				if (request.kind !== "confirm" || !request.runId || request.revision === undefined) return;
				if (!request.toolCallId) throw new Error("Approval is missing its tool call ID");
				resolveExtUi({
					id: request.id,
					sessionId: request.sessionId,
					runId: request.runId,
					revision: request.revision,
					toolCallId: request.toolCallId,
					value: true,
				});
			});
			const { sessionId } = await createSession({ cwd: repo, workspaceId: "w1" });
			await promptSession(sessionId, "Write feature.ts");
			expect(recording).toBeDefined();
			expect(listTurns("w1")).toEqual([]);
			if (teardown === "removeSession") {
				await removeSession(sessionId);
				expect(getSessionWorkspaceId(sessionId)).toBeUndefined();
			} else {
				const closing = server.shutdown();
				expect(server.shutdown()).toBe(closing);
				expect(
					await Promise.race([closing.then(() => "closed"), Bun.sleep(25).then(() => "recording")]),
				).toBe("recording");
			}
			releaseHead.resolve();
			if (teardown === "shutdown") await server.shutdown();
			else await recording;

			expect(trees).toHaveLength(2);
			expect(trees[0]).not.toBeNull();
			expect(trees[1]).not.toBeNull();
			expect(trees[0]).not.toBe(trees[1]);
			expect(getWorkspace("w1").worktreePath).toBe(repo);
			const turns = listTurns("w1");
			expect(turns).toHaveLength(1);
			expect(turns[0]).toMatchObject({ sessionId, workspaceId: "w1" });
			expect(turns[0]?.changes.map((change) => change.path)).toEqual(["feature.ts"]);
			expect(loadTurns().byWorkspace.w1).toEqual(turns);
		} finally {
			releaseHead.resolve();
			await recording;
			snapshotSpy.mockRestore();
			observeSpy.mockRestore();
		}
	},
);

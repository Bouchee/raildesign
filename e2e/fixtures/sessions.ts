import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState, Workspace } from "@thinkrail/contracts";
import { sessionDirFor, writeFixtureSession } from "@thinkrail/server/history-test-fixtures";
import { E2E_DATA_DIR } from "./paths";

export const E2E_EXTERNAL_CWD = "/tmp/thinkrail-e2e-external";

const BASE_TS = 1_700_000_000_000;

export function completedFixtureState(completionId: string): SessionState {
	return {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: { completionId, outcome: "succeeded" },
		completionUnread: true,
		queuedCount: 0,
		backgroundWork: false,
	};
}

export function pendingToolFixtureState(toolCallId: string): SessionState {
	return {
		execution: "idle",
		runId: `fixture-run-${toolCallId}`,
		needsInput: { kind: "tool-response", interactionId: toolCallId, toolCallId },
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
}

export function seedExternalCwdSessions(dataDirectory: string = E2E_DATA_DIR): void {
	const dir = sessionDirFor(dataDirectory);

	writeFixtureSession(dir, {
		id: "e2e-fixture-deploy-docs",
		cwd: E2E_EXTERNAL_CWD,
		messages: [
			{ role: "user", text: "deploy the docs site", timestamp: BASE_TS },
			{
				role: "assistant",
				text: "Deployed the docs site — all checks green.",
				timestamp: BASE_TS + 1_000,
			},
			{ role: "user", text: "fix the flaky watcher test", timestamp: BASE_TS + 2_000 },
			{
				role: "assistant",
				text: "Fixed it: the debounce window overlaps with the poll interval, so I widened it.",
				timestamp: BASE_TS + 3_000,
			},
		],
	});

	writeFixtureSession(dir, {
		id: "e2e-fixture-dependency-pins",
		cwd: E2E_EXTERNAL_CWD,
		messages: [{ role: "user", text: "update dependency pins", timestamp: BASE_TS + 10_000 }],
	});
}

export function seedWorkspaceSession(
	worktreePath: string,
	opts: Omit<Parameters<typeof writeFixtureSession>[1], "cwd">,
): { id: string; path: string } {
	const workspaces = ["workspaces.json", "chats.json"].flatMap((file): Workspace[] => {
		try {
			const record = JSON.parse(readFileSync(join(E2E_DATA_DIR, file), "utf8"));
			return file === "chats.json" ? record.chats : record;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
	});
	const workspaceId =
		opts.workspaceId ?? workspaces.find((workspace) => workspace.worktreePath === worktreePath)?.id;
	if (!workspaceId) throw new Error(`No fixture workspace registered for ${worktreePath}`);
	return writeFixtureSession(sessionDirFor(E2E_DATA_DIR), {
		...opts,
		workspaceId,
		cwd: worktreePath,
	});
}

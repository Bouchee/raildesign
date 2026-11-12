import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceRecord } from "@thinkrail/contracts";
import type { BackgroundCommandSnapshot, BackgroundCommands } from "pi-background-commands";
import type { ChildHandle } from "pi-delegation";
import { archivedCommandOutput, finishedResources, recordResource } from "../resourceHistory";
import {
	archiveCommandHistory,
	archiveSubagentRun,
	getResourceHistoryPage,
	getSessionResources,
	ownedChildResources,
	subagentSummary,
} from "./chatResources";
import { isHostResourceId } from "./resourceIdentity";

let root: string;
let previousData: string | undefined;
const scope = { workspaceId: "workspace", sessionId: "parent" };
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-resources-"));
	previousData = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = root;
});
afterEach(() => {
	if (previousData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previousData;
	rmSync(root, { recursive: true, force: true });
});
const command = (
	id: string,
	status: BackgroundCommandSnapshot["status"] = "completed",
	startedAt = 1,
): Extract<ResourceRecord, { kind: "command" }> => ({
	kind: "command",
	summary: {
		id,
		sessionId: scope.sessionId,
		name: id,
		command: `run ${id}`,
		status,
		startedAt,
		...(status === "completed" ? { finishedAt: startedAt + 1, exitCode: 0 } : {}),
	},
});
function child(
	id: string,
	workspaceId = scope.workspaceId,
	parentSessionId = scope.sessionId,
): ChildHandle {
	return {
		sessionId: id,
		record: {
			sessionId: id,
			parentSessionId,
			scope: workspaceId,
			originKind: "fresh",
			info: { createdBy: "test", roleName: "x".repeat(300), detached: true },
			interactive: false,
			visibility: "hidden",
			createdAt: "2026-01-01T00:00:00Z",
			sessionFile: "private-transcript",
		},
		snapshot: {
			status: "running",
			task: "t".repeat(3_000),
			details: {
				childSessionId: id,
				task: "private-task",
				status: "running",
				model: "test/model",
				durationMs: 100,
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 1,
					contextTokens: 3,
				},
			},
			collected: false,
		},
		async runNow() {
			throw new Error("No executor");
		},
		async runQueued() {
			throw new Error("No executor");
		},
		async steer() {},
		async abort() {},
		async dispose() {},
		onEvent: () => () => {},
		collectResult: () => undefined,
	};
}

test("host ids accept only bounded plain components and scope validation fails closed", () => {
	for (const value of ["a", "workspace_1", "session-123", "a".repeat(200)])
		expect(isHostResourceId(value)).toBe(true);
	for (const value of [
		"",
		".",
		"..",
		"session.id",
		"../x",
		"x/y",
		"x\\y",
		"a".repeat(201),
		null,
		1,
	])
		expect(isHostResourceId(value)).toBe(false);
	for (const invalid of [
		{ workspaceId: "../x", sessionId: "parent" },
		{ workspaceId: "workspace", sessionId: "bad/id" },
	])
		expect(() => getSessionResources(invalid, [])).toThrow("Resource unavailable");
});

test("merge keeps live ownership, prefers the owner's real settlement over derived interruption and filters foreign parents", () => {
	recordResource(scope, command("live", "running"));
	recordResource(scope, command("settled", "running"));
	recordResource(scope, command("lost", "running"));
	const foreign = command("foreign");
	foreign.summary = { ...foreign.summary, sessionId: "other" };
	const summary = getSessionResources(scope, [
		command("live", "running"),
		command("settled"),
		foreign,
	]);
	expect(summary.commands.map(({ id }) => id)).toEqual(["live", "settled", "lost"]);
	expect(summary.commands.find(({ id }) => id === "settled")?.interrupted).toBeUndefined();
	expect(summary.commands.find(({ id }) => id === "lost")?.interrupted).toBe(true);
	expect(summary.history?.commands).toEqual({ done: 1, failed: 0, stopped: 0, interrupted: 1 });
	expect(JSON.stringify(summary)).not.toContain("output");
});

test("all live records stay visible beside the newest twenty finished records and history paging is bounded", () => {
	const records = [
		...Array.from({ length: 125 }, (_, index) => command(`done-${index}`, "completed", index)),
		...Array.from({ length: 3 }, (_, index) => command(`live-${index}`, "running", index)),
	];
	const summary = getSessionResources(scope, records);
	expect(summary.commands).toHaveLength(23);
	expect(summary.commands.slice(0, 3).map(({ id }) => id)).toEqual(["live-0", "live-1", "live-2"]);
	expect(summary.commands[3]?.id).toBe("done-124");
	expect(summary.history?.commands.done).toBe(125);
	const maximum = getResourceHistoryPage(scope, records, { kind: "command", limit: 1_000 });
	expect(maximum.items).toHaveLength(100);
	expect(maximum.hasMore).toBe(true);
	expect(getResourceHistoryPage(scope, records, { kind: "command", limit: -1 }).items).toHaveLength(
		1,
	);
	expect(
		getResourceHistoryPage(scope, records, { kind: "command", limit: Number.NaN }).items,
	).toHaveLength(20);
});

test("child summaries clip public metadata, hide transcript bytes and retain both ownership checks", () => {
	const own = child("own"),
		foreign = child("foreign", "other"),
		sibling = child("sibling", "workspace", "other");
	const records = ownedChildResources({ childrenOf: () => [own, foreign, sibling] }, scope);
	expect(records).toHaveLength(1);
	const summary = subagentSummary(own, scope.sessionId);
	expect(summary?.roleName).toHaveLength(200);
	expect(summary?.task).toHaveLength(2_000);
	expect(summary?.detached).toBe(true);
	expect(summary?.durationMs).toBeUndefined();
	expect(JSON.stringify(summary)).not.toContain("private-transcript");
	expect(subagentSummary({ ...own, snapshot: undefined }, scope.sessionId)).toBeUndefined();
});

test("command archiving separates explicit user Stop from teardown and preserves the final log tail", () => {
	const snapshots = new Map<string, BackgroundCommandSnapshot>();
	const listeners = new Set<() => void>();
	const commands: Pick<BackgroundCommands, "sessionId" | "list" | "find" | "onChange"> = {
		sessionId: scope.sessionId,
		list: () => [...snapshots.values()],
		find: (id) => {
			const snapshot = snapshots.get(id);
			return snapshot
				? {
						id,
						snapshot,
						output: { text: `log of ${id}`, truncated: false },
						stop: () => snapshot,
						claimCompletion: () => {},
					}
				: undefined;
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	function report(id: string, patch: Partial<BackgroundCommandSnapshot>) {
		snapshots.set(id, {
			id,
			sessionId: scope.sessionId,
			name: id,
			command: `run ${id}`,
			status: "running",
			startedAt: 1,
			...snapshots.get(id),
			...patch,
		});
		for (const listener of listeners) listener();
	}
	let closing = false;
	report("user", {});
	const archive = archiveCommandHistory(
		scope.workspaceId,
		scope.sessionId,
		commands,
		() => closing,
	);
	report("cut", {});
	report("hung", {});
	report("user", { status: "stopping" });
	closing = true;
	report("cut", { status: "stopping" });
	report("hung", { status: "stopping" });
	report("user", { status: "stopped", finishedAt: 5 });
	report("cut", { status: "stopped", finishedAt: 6 });
	archive.finish();
	report("hung", { status: "stopped", finishedAt: 7 });
	const archived = new Map(
		finishedResources(scope, "command", new Set()).map(({ summary }) => [
			"id" in summary ? summary.id : "",
			summary,
		]),
	);
	expect(archived.get("user")?.interrupted).toBeUndefined();
	expect(archived.get("cut")?.interrupted).toBe(true);
	expect(archived.get("hung")?.interrupted).toBe(true);
	expect(archivedCommandOutput(scope, "cut")).toEqual({ text: "log of cut", truncated: false });
	expect(archivedCommandOutput(scope, "hung")).toEqual({ text: "log of hung", truncated: false });
	expect(listeners.size).toBe(0);
});

test("child archival rejects foreign lifecycle events and marks only interrupted aborts", () => {
	const own = child("own");
	if (!own.snapshot) throw new Error("Missing fixture snapshot");
	const terminal = {
		...own,
		snapshot: {
			...own.snapshot,
			status: "aborted" as const,
			details: { ...own.snapshot.details, status: "aborted" as const, abortReason: "interrupted" },
		},
	};
	const service = { findChild: () => terminal };
	archiveSubagentRun(scope.workspaceId, service, {
		type: "run-started",
		sessionId: "own",
		parentSessionId: "foreign",
	});
	expect(
		finishedResources(
			{ workspaceId: scope.workspaceId, sessionId: "foreign" },
			"subagent",
			new Set(),
		),
	).toEqual([]);
	archiveSubagentRun(scope.workspaceId, service, {
		type: "run-terminal",
		sessionId: "own",
		parentSessionId: scope.sessionId,
		outcome: { historyEntryId: null, status: "aborted", details: terminal.snapshot.details },
	});
	expect(finishedResources(scope, "subagent", new Set())[0]?.summary.interrupted).toBe(true);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceRecord } from "@thinkrail/contracts";
import { archivedCommandOutput, finishedResources, recordResource } from "../resourceHistory";
import type { BackgroundCommandSnapshot, BackgroundCommands } from "./backgroundCommands";
import {
	archiveCommandHistory,
	getResourceHistoryPage,
	getSessionResources,
} from "./chatResources";
import { isHostResourceId } from "./resourceIdentity";

let root: string;
let previousData: string | undefined;
const scope = { workspaceId: "workspace", sessionId: "parent", commandSessionIds: ["parent"] };
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
		expect(() =>
			getSessionResources({ ...invalid, commandSessionIds: [invalid.sessionId] }, []),
		).toThrow("Resource unavailable");
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

test("child command summaries retain actual owners only when explicitly authorized", () => {
	const owned = command("owned-child-command");
	owned.summary.sessionId = "child";
	const foreign = command("foreign-child-command");
	foreign.summary.sessionId = "foreign";
	const summary = getSessionResources({ ...scope, commandSessionIds: [scope.sessionId, "child"] }, [
		owned,
		foreign,
	]);
	expect(summary.commands).toEqual([owned.summary]);
	expect(getSessionResources(scope, [owned]).commands).toEqual([]);
});

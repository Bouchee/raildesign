import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listSessionRecords,
	PersistentSession,
	readSessionRecord,
	type SessionRecord,
	sessionRecordPath,
} from "./sessionStore";

let directory: string;
let previous: string | undefined;
function record(): SessionRecord {
	return {
		version: 1,
		sessionId: "safe-session-id",
		workspaceId: "workspace",
		cwd: directory,
		model: null,
		thinkingLevel: "off",
		eventSeq: 0,
		revision: 0,
		history: [],
		messages: [],
		state: {
			execution: "idle",
			runId: null,
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
		updatedAt: Date.now(),
		decisions: {},
	};
}
beforeEach(() => {
	previous = process.env.THINKRAIL_DATA_DIR;
	directory = mkdtempSync(join(tmpdir(), "raildesign-session-store-"));
	process.env.THINKRAIL_DATA_DIR = directory;
});
afterEach(() => {
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
	rmSync(directory, { recursive: true, force: true });
});

test("Session public history reads are detached and SDK pop/re-add remains valid", async () => {
	const store = new PersistentSession(record());
	await store.addItems([{ id: "input", role: "user", content: "hello" }]);
	const items = await store.getItems();
	items.pop();
	expect(await store.getItems()).toHaveLength(1);
	expect(await store.getItems(0)).toEqual([]);
	expect(() => store.getItems(-1)).toThrow("Invalid history limit");
	const popped = await store.popItem();
	if (!popped) throw new Error("Missing item");
	await store.addItems([popped]);
	expect(await store.getItems()).toHaveLength(1);
	await store.clearSession();
	expect(await store.getItems()).toEqual([]);
	expect(readSessionRecord("safe-session-id")?.revision).toBe(4);
});

test("invalid IDs and corrupt history or lifecycle data fail before attachment", () => {
	for (const id of ["../escape", "/outside", "with/slash", ""])
		expect(() => sessionRecordPath(id)).toThrow("Invalid session ID");
	const store = new PersistentSession(record());
	store.update(() => {});
	for (const change of [
		{ history: [{ type: "function_call", callId: 8 }] },
		{ state: { execution: "invented" } },
		{ messages: [{ role: "assistant", timestamp: 1 }] },
	]) {
		writeFileSync(sessionRecordPath("safe-session-id"), JSON.stringify({ ...record(), ...change }));
		expect(() => readSessionRecord("safe-session-id")).toThrow();
	}
});

test("listing skips unreadable records and keeps readable sessions", () => {
	new PersistentSession(record()).update(() => {});
	writeFileSync(join(directory, "sessions", "truncated.json"), "{");
	writeFileSync(
		join(directory, "sessions", "older-format.json"),
		JSON.stringify({ ...record(), sessionId: "older-format", version: 0 }),
	);
	expect(listSessionRecords().map((value) => value.sessionId)).toEqual(["safe-session-id"]);
	expect(() => readSessionRecord("truncated")).toThrow();
});

test("a failed atomic write preserves the previous in-memory revision and record bytes", () => {
	const store = new PersistentSession(record());
	store.update(() => {});
	const before = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	renameSync(join(directory, "sessions"), join(directory, "saved-sessions"));
	writeFileSync(join(directory, "sessions"), "not a directory");
	expect(() =>
		store.update((value) => {
			value.title = "must not commit";
		}),
	).toThrow();
	expect(store.record.title).toBeUndefined();
	expect(store.record.revision).toBe(1);
	expect(readFileSync(join(directory, "saved-sessions", "safe-session-id.json"), "utf8")).toBe(
		before,
	);
});

test("a Session retains its original data directory when process environment changes", async () => {
	const store = new PersistentSession(record());
	store.update(() => {});
	const other = join(directory, "other-data");
	process.env.THINKRAIL_DATA_DIR = other;
	await store.addItems([{ role: "user", content: "after environment change" }]);
	expect(existsSync(join(other, "sessions"))).toBe(false);
	expect(
		JSON.parse(readFileSync(join(directory, "sessions", "safe-session-id.json"), "utf8")).history,
	).toHaveLength(1);
});

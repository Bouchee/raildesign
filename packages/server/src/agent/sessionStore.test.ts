import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { assistantMessage, modelResponder, ScriptedModel } from "@openai/agents/testing";
import {
	listSessionRecords,
	PersistentSession,
	readSessionRecord,
	type SessionRecord,
	sessionRecordPath,
} from "./sessionStore";
import { estimateSessionTokens } from "./sessionSummary";

let directory: string;
let previous: string | undefined;
function record(): SessionRecord {
	return {
		version: 2,
		sessionId: "safe-session-id",
		workspaceId: "workspace",
		cwd: directory,
		model: null,
		thinkingLevel: "off",
		eventSeq: 0,
		revision: 0,
		history: [],
		inputItems: {},
		historyOperations: {},
		summaryOperations: {},
		retiredInputIds: [],
		queue: [],
		effects: {},
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
		toolResponses: {},
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
	for (const version of [0, 1, 3]) {
		const id = `other-format-${version}`;
		writeFileSync(
			join(directory, "sessions", `${id}.json`),
			JSON.stringify({ ...record(), sessionId: id, version }),
		);
	}
	expect(listSessionRecords().map((value) => value.sessionId)).toEqual(["safe-session-id"]);
	expect(() => readSessionRecord("truncated")).toThrow();
	for (const version of [0, 1, 3]) {
		const id = `other-format-${version}`;
		const path = sessionRecordPath(id);
		const before = readFileSync(path, "utf8");
		expect(() => readSessionRecord(id)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
	}
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

test("history transactions persist input handover and receipts once across reopen and later turns", async () => {
	const store = new PersistentSession(record());
	store.record.queue = [{ id: "queued", text: "once", kind: "steering", state: "staged" }];
	const transaction = {
		operationId: "handover",
		transaction: { type: "append_items" as const, items: [input("queued", "once")] },
	};
	await store.applyHistoryTransaction(transaction);
	expect(store.record.queue).toEqual([]);
	expect(store.record.state.queuedCount).toBe(0);
	expect(store.record.messages).toMatchObject([{ id: "queued", role: "user", content: "once" }]);
	const reopened = new PersistentSession(readSessionRecord("safe-session-id") ?? record());
	await reopened.addItems([input("later", "another turn")]);
	const bytes = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	await reopened.applyHistoryTransaction(transaction);
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(bytes);
	expect(await reopened.getItems()).toEqual([
		input("queued", "once"),
		input("later", "another turn"),
	]);
	expect(() =>
		reopened.applyHistoryTransaction({
			...transaction,
			transaction: { type: "append_items", items: [input("queued", "changed")] },
		}),
	).toThrow("Conflicting history operation");
});

test("suffix replacement checks its old suffix, dedupes stable IDs and rejects changed user content", async () => {
	const store = new PersistentSession(record());
	const first = input("first", "same text");
	const second = input("second", "same text");
	await store.addItems([first, second]);
	await store.applyHistoryTransaction({
		operationId: "replace",
		transaction: { type: "replace_suffix", expectedSuffix: [second], replacement: [first, second] },
	});
	expect(await store.getItems()).toEqual([first, second]);
	const bytes = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	expect(() =>
		store.applyHistoryTransaction({
			operationId: "stale",
			transaction: { type: "replace_suffix", expectedSuffix: [first], replacement: [] },
		}),
	).toThrow("History suffix does not match");
	expect(() => store.addItems([input("first", "changed")])).toThrow("Conflicting user input ID");
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(bytes);
});

test("history metadata and transcript identity conflicts fail before a write or receipt", () => {
	const store = new PersistentSession(record());
	store.record.messages = [{ id: "existing", role: "user", content: "original", timestamp: 1 }];
	store.update(() => {});
	const bytes = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	expect(() => store.addItems([input("existing", "changed")])).toThrow("Conflicting transcript");
	expect(() =>
		store.applyHistoryTransaction({
			operationId: "bad-metadata",
			transaction: {
				type: "append_items",
				items: [{ ...input("bad", "content"), providerData: { bad: () => {} } }],
			},
		}),
	).toThrow("History metadata must be JSON data");
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(bytes);
});

function input(id: string, content: string): AgentInputItem {
	return { type: "message", role: "user", id, content };
}

function completeHistory(): AgentInputItem[] {
	return [
		input("older", `Project ORBIT uses a blue label. ${"Historical detail. ".repeat(70)}`),
		assistantMessage("ORBIT and blue are required.", { id: "older-answer" }),
		input("recent", "Launch on Tuesday."),
		{
			type: "function_call",
			callId: "recent-call",
			name: "read_file",
			arguments: '{"path":"schedule.txt"}',
			status: "completed",
		},
		{
			type: "function_call_result",
			callId: "recent-call",
			name: "read_file",
			output: { type: "text", text: "Tuesday" },
			status: "completed",
		},
		assistantMessage("Tuesday is retained.", { id: "recent-answer" }),
	];
}

const compactOptions = (operationId = "summary", force = true) => ({
	operationId,
	force,
	tokenBudget: 8192,
	signal: new AbortController().signal,
	summarize: async () => "Project ORBIT uses a blue label.",
});

test("summary retains the full newest tool exchange and transcript, then a new SDK agent continues", async () => {
	const store = new PersistentSession(record());
	const history = completeHistory();
	await store.addItems(history);
	store.update((value) => {
		value.messages = [
			{ id: "older", role: "user", content: "Full transcript retained", timestamp: 1 },
		];
	});
	const transcript = structuredClone(store.record.messages);
	const result = await store.compact({
		...compactOptions(),
		summarize: async (prefix) => {
			expect(prefix).toEqual(history.slice(0, 2));
			prefix.splice(0);
			return "Project ORBIT uses a blue label.";
		},
	});
	expect(result.status).toBe("compacted");
	expect(result.afterTokens).toBeLessThan(result.beforeTokens);
	expect((await store.getItems()).slice(1)).toEqual(history.slice(2));
	expect(store.record.messages).toEqual(transcript);
	const model = new ScriptedModel([
		modelResponder(({ request }) => {
			expect(JSON.stringify(request.input)).toContain("ORBIT uses a blue label");
			expect(JSON.stringify(request.input)).toContain("Tuesday");
			return [assistantMessage("ORBIT, blue, Tuesday")];
		}),
	]);
	const continued = await new Runner({ tracingDisabled: true }).run(
		new Agent({ name: "summary-continuation", model }),
		"Recall the facts",
		{ session: store },
	);
	expect(continued.finalOutput).toBe("ORBIT, blue, Tuesday");
	expect(store.record.messages).toEqual(transcript);
});

test("summary token threshold skips without generation and settled history above budget compacts", async () => {
	const store = new PersistentSession(record());
	await store.addItems(completeHistory());
	let requests = 0;
	const summarize = async () => {
		requests += 1;
		return "ORBIT is blue.";
	};
	expect((await store.compact({ ...compactOptions("below", false), summarize })).status).toBe(
		"skipped",
	);
	expect(requests).toBe(0);
	const budget = Math.floor(estimateSessionTokens(store.record.history));
	expect(
		(await store.compact({ ...compactOptions("above", false), tokenBudget: budget, summarize }))
			.status,
	).toBe("compacted");
	expect(requests).toBe(1);
});

test("successful summary replay preserves later turns and retired input IDs; explicit reset permits re-add", async () => {
	const store = new PersistentSession(record());
	const history = completeHistory();
	await store.addItems(history);
	await store.compact(compactOptions());
	await store.addItems([input("later", "New fact")]);
	const bytes = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	expect(
		(
			await store.compact({
				...compactOptions(),
				summarize: async () => {
					throw new Error("must not generate");
				},
			})
		).status,
	).toBe("replayed");
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(bytes);
	await expect(store.compact({ ...compactOptions(), force: false })).rejects.toThrow(
		"Conflicting summary operation",
	);
	await expect(
		store.compact({ ...compactOptions(), instructions: "different request" }),
	).rejects.toThrow("Conflicting summary operation");
	const older = history[0];
	if (!older) throw new Error("Missing older input");
	await store.addItems([older]);
	expect(store.record.history.some((item) => item.id === "older")).toBe(false);
	const recent = await store.popItem();
	if (!recent) throw new Error("Missing recent input");
	await store.addItems([recent]);
	expect(store.record.history.at(-1)).toEqual(recent);
	await store.clearSession();
	await store.addItems([older]);
	expect(store.record.history).toEqual([older]);
	expect(store.record.summaryOperations.summary).toBeDefined();
	expect(store.record.historyOperations).not.toBeUndefined();
});

test.each(["generation", "empty", "oversized", "not-smaller", "abort", "revision", "write"])(
	"summary %s failure preserves the last committed record and never records success",
	async (failure) => {
		const store = new PersistentSession(record());
		await store.addItems(completeHistory());
		const before = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
		const controller = new AbortController();
		let latest = before;
		await expect(
			store.compact({
				...compactOptions(),
				signal: controller.signal,
				summarize: async () => {
					if (failure === "generation") throw new Error("provider failed");
					if (failure === "empty") return " ";
					if (failure === "oversized") return "x".repeat(8193);
					if (failure === "not-smaller") return "x".repeat(2000);
					if (failure === "abort") controller.abort();
					if (failure === "revision") {
						store.update((value) => {
							value.title = "Newer title";
						});
						latest = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
					}
					if (failure === "write") {
						renameSync(join(directory, "sessions"), join(directory, "saved-sessions"));
						writeFileSync(join(directory, "sessions"), "not a directory");
					}
					return "ORBIT is blue.";
				},
			}),
		).rejects.toThrow();
		const path =
			failure === "write"
				? join(directory, "saved-sessions", "safe-session-id.json")
				: sessionRecordPath("safe-session-id");
		expect(readFileSync(path, "utf8")).toBe(latest);
		expect(store.record.summaryOperations).toEqual({});
	},
);

test("summary rejects pending checkpoints and malformed function groups before generation", async () => {
	const store = new PersistentSession(record());
	await store.addItems(completeHistory());
	let requests = 0;
	const summarize = async () => {
		requests += 1;
		return "ORBIT is blue.";
	};
	store.update((value) => {
		value.runCheckpoint = {
			runId: "run",
			checkpoint: "private",
			granted: true,
			enabledExtensions: [{ name: "ask-user-question", settings: { richPreviews: true } }],
		};
	});
	await expect(store.compact({ ...compactOptions(), summarize })).rejects.toThrow("settled run");
	store.update((value) => {
		delete value.runCheckpoint;
		value.pendingToolResponse = {
			id: "question",
			sessionId: value.sessionId,
			runId: "run",
			revision: value.revision,
			toolCallId: "question-call",
			toolName: "ask_user_question",
			args: { questions: [] },
			checkpoint: "private question checkpoint",
		};
	});
	expect(readSessionRecord("safe-session-id")?.pendingToolResponse?.toolCallId).toBe(
		"question-call",
	);
	await expect(store.compact({ ...compactOptions(), summarize })).rejects.toThrow("settled run");
	store.update((value) => {
		delete value.pendingToolResponse;
		value.history = value.history.filter((item) => item.type !== "function_call_result");
	});
	await expect(store.compact({ ...compactOptions(), summarize })).rejects.toThrow(
		"Unmatched function call",
	);
	expect(requests).toBe(0);
});

test("summary marker and history commit together, including failed writes", async () => {
	const store = new PersistentSession(record());
	await store.addItems(completeHistory());
	const before = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	const original = store.update.bind(store);
	store.update = () => {
		throw new Error("Commit failed");
	};
	await expect(
		store.compact({ ...compactOptions("marker"), tokensBefore: 42, summarize: async () => "fact" }),
	).rejects.toThrow("Commit failed");
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(before);
	expect(store.record.summaryOperations.marker).toBeUndefined();
	store.update = original;
	await store.compact({
		...compactOptions("marker"),
		tokensBefore: 42,
		summarize: async () => "fact",
	});
	const reopened = readSessionRecord("safe-session-id");
	expect(reopened?.summaryOperations.marker).toBeDefined();
	expect(reopened?.messages.at(-1)).toMatchObject({
		id: "summary:marker",
		role: "compactionSummary",
		summary: "fact",
		tokensBefore: 42,
	});
});

test("successful summary receipts retain detached SDK usage once across replay", async () => {
	const store = new PersistentSession(record());
	await store.addItems(completeHistory());
	const usage = { input: 30, output: 12, cacheRead: 4, cacheWrite: 2, total: 42 };
	await store.compact({ ...compactOptions("usage"), usage, summarize: async () => "fact" });
	usage.input = 900;
	const reopened = new PersistentSession(readSessionRecord("safe-session-id") ?? record());
	expect(reopened.record.summaryOperations.usage?.usage).toEqual({
		input: 30,
		output: 12,
		cacheRead: 4,
		cacheWrite: 2,
		total: 42,
	});
	const before = readFileSync(sessionRecordPath("safe-session-id"), "utf8");
	await reopened.compact({
		...compactOptions("usage"),
		usage,
		summarize: async () => {
			throw new Error("Successful replay must not request another summary");
		},
	});
	expect(readFileSync(sessionRecordPath("safe-session-id"), "utf8")).toBe(before);
});

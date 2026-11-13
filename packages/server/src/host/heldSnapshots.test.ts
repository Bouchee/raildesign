import { expect, test } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	SessionEvent,
	SessionEventPayload,
} from "@thinkrail/contracts";
import { HeldSnapshots, snapshotKey, terminalsMayResume } from "./heldSnapshots";
import type { SendOutcome } from "./socketSend";

const partial: AssistantMessage = {
	id: "assistant",
	role: "assistant",
	content: [],
	timestamp: 0,
	api: "fixture",
	provider: "fixture",
	model: "fixture",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const message = (
	assistantMessageEvent: AssistantMessageEvent = {
		type: "text_delta",
		contentIndex: 0,
		delta: "x",
		partial,
	},
): SessionEvent => ({ type: "message_update", message: partial, assistantMessageEvent });
const toolUpdate = (toolCallId: string, text: string): SessionEvent => ({
	type: "tool_execution_update",
	toolCallId,
	toolName: "bash",
	args: {},
	partialResult: { content: [{ type: "text", text }] },
});
let sequence = 0;
const event = (sessionId: string, event: SessionEvent): SessionEventPayload => ({
	sessionId,
	runId: "run",
	seq: ++sequence,
	event,
});

function fakeSocket(outcomes: SendOutcome[] = []) {
	const socket = {
		buffered: 0,
		slow: false,
		sent: [] as string[],
		quarantined: () => socket.slow,
		getBufferedAmount: () => socket.buffered,
		send(frame: string): SendOutcome {
			socket.sent.push(frame);
			return outcomes.shift() ?? "delivered";
		},
	};
	return socket;
}

test("only partial-carrying message updates and tool updates are replaceable snapshots", () => {
	const updates: AssistantMessageEvent[] = [
		{ type: "start", partial },
		{ type: "text_start", contentIndex: 0, partial },
		{ type: "text_delta", contentIndex: 0, delta: "x", partial },
		{ type: "text_end", contentIndex: 0, content: "x", partial },
		{ type: "thinking_start", contentIndex: 0, partial },
		{ type: "thinking_delta", contentIndex: 0, delta: "x", partial },
		{ type: "thinking_end", contentIndex: 0, content: "x", partial },
		{ type: "toolcall_start", contentIndex: 0, partial },
		{ type: "toolcall_delta", contentIndex: 0, delta: "x", partial },
		{
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: {} },
			partial,
		},
	];
	for (const update of updates)
		expect(snapshotKey(event("s", message(update)))).toBe(JSON.stringify(["s", "message"]));
	expect(snapshotKey(event("s", toolUpdate("t1", "x")))).toBe(JSON.stringify(["s", "tool", "t1"]));
	const milestones: SessionEvent[] = [
		message({ type: "done", reason: "stop", message: partial }),
		message({ type: "error", reason: "error", error: partial }),
		{ type: "bash_execution_update", delta: "x" },
		{ type: "message_end", message: partial },
		{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false },
		{ type: "agent_settled", terminal: null },
		{ type: "queue_update", steering: [], followUp: [] },
	];
	for (const milestone of milestones) expect(snapshotKey(event("s", milestone))).toBeUndefined();
});

test("an empty buffer sends every snapshot at once", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	expect(held.deliver(event("s", toolUpdate("t1", "a")), "a")).toBe("delivered");
	expect(held.deliver(event("s", toolUpdate("t1", "b")), "b")).toBe("delivered");
	expect(socket.sent).toEqual(["a", "b"]);
	expect(held.size).toBe(0);
});

test("a backlog keeps only the newest snapshot per stream and sends it once the buffer is empty", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	for (const frame of ["a1", "a2", "a3"]) held.deliver(event("s", toolUpdate("t1", frame)), frame);
	held.deliver(event("s", toolUpdate("t2", "b1")), "b1");
	held.deliver(event("other", toolUpdate("t1", "c1")), "c1");
	held.deliver(event("s", message()), "m1");
	expect(socket.sent).toEqual([]);
	expect(held.drain()).toBe("waiting");
	socket.buffered = 0;
	expect(held.drain()).toBe("flushed");
	expect(socket.sent).toEqual(["a3", "b1", "c1", "m1"]);
	expect(held.drain()).toBe("idle");
});

test("a re-held stream moves behind the snapshots that arrived after its older one", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", message()), "m1");
	held.deliver(event("s", toolUpdate("t1", "a")), "t1");
	held.deliver(event("s", message()), "m2");
	socket.buffered = 0;
	held.drain();
	expect(socket.sent).toEqual(["t1", "m2"]);
});

test("an opportunistic flush stops at backpressure and keeps the unsent rest", () => {
	const socket = fakeSocket(["backpressured"]);
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", toolUpdate("t1", "a")), "a");
	held.deliver(event("s", toolUpdate("t2", "b")), "b");
	socket.buffered = 0;
	expect(held.drain()).toBe("backpressured");
	expect(socket.sent).toEqual(["a"]);
	expect(held.size).toBe(1);
	expect(held.drain()).toBe("flushed");
	expect(socket.sent).toEqual(["a", "b"]);
});

test("any later frame of a session first sends that session's held snapshots, through backpressure", () => {
	const socket = fakeSocket(["backpressured", "backpressured"]);
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", message()), "m1");
	held.deliver(event("s", toolUpdate("t1", "a")), "t1");
	held.deliver(event("other", toolUpdate("t1", "x")), "x");
	const end: SessionEvent = { type: "message_end", message: partial };
	expect(held.deliver(event("s", end), "end")).toBe("delivered");
	expect(socket.sent).toEqual(["m1", "t1", "end"]);
	expect(held.barrier("other")).toBe(true);
	expect(socket.sent).toEqual(["m1", "t1", "end", "x"]);
	expect(held.size).toBe(0);
});

test("a replaceable snapshot sent on an empty buffer goes after the session's older held ones", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", toolUpdate("t1", "a")), "a");
	socket.buffered = 0;
	held.deliver(event("s", toolUpdate("t2", "b")), "b");
	expect(socket.sent).toEqual(["a", "b"]);
});

test("a dropped send clears the socket's held snapshots and skips the frame behind it", () => {
	const socket = fakeSocket(["dropped"]);
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", toolUpdate("t1", "a")), "a");
	held.deliver(event("other", toolUpdate("t1", "x")), "x");
	expect(held.deliver(event("s", { type: "agent_settled", terminal: null }), "settled")).toBe(
		"dropped",
	);
	expect(socket.sent).toEqual(["a"]);
	expect(held.size).toBe(0);
});

test("a deleted session's held snapshots are forgotten", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", toolUpdate("t1", "a")), "a");
	held.deliver(event("other", toolUpdate("t1", "x")), "x");
	held.forgetSession("s");
	socket.buffered = 0;
	held.drain();
	expect(socket.sent).toEqual(["x"]);
});

test("a socket quarantined by any send drops its held snapshots and holds no new ones", () => {
	const socket = fakeSocket();
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("s", toolUpdate("t1", "a")), "a");
	socket.slow = true;
	expect(held.deliver(event("s", toolUpdate("t1", "b")), "b")).toBe("dropped");
	expect(held.size).toBe(0);
	expect(socket.sent).toEqual([]);
});

test("a dropped frame behind an empty barrier clears the other sessions' held snapshots", () => {
	const socket = fakeSocket(["dropped"]);
	const held = new HeldSnapshots(socket);
	socket.buffered = 1;
	held.deliver(event("other", toolUpdate("t1", "x")), "x");
	expect(held.deliver(event("s", { type: "agent_settled", terminal: null }), "settled")).toBe(
		"dropped",
	);
	expect(held.size).toBe(0);
});

test("terminal output resumes on a drain only once no snapshot is left waiting for an empty buffer", () => {
	expect(terminalsMayResume(undefined)).toBe(true);
	expect(terminalsMayResume("idle")).toBe(true);
	expect(terminalsMayResume("flushed")).toBe(true);
	expect(terminalsMayResume("waiting")).toBe(false);
	expect(terminalsMayResume("backpressured")).toBe(false);
	expect(terminalsMayResume("dropped")).toBe(false);
});

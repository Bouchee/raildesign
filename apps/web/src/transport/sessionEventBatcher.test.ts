import { expect, test } from "bun:test";
import type { SessionEvent, SessionEventPayload, WsServerMessage } from "@thinkrail/contracts";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { createSessionEventBatcher, shouldFlushSessionEventsBefore } from "./sessionEventBatcher";

const payload = (sessionId: string, type: SessionEvent["type"]): SessionEventPayload => ({
	sessionId,
	runId: "run",
	seq: 1,
	event: { type } as SessionEvent,
});

function manualScheduler() {
	let scheduled: (() => void) | null = null;
	return {
		schedule: (flush: () => void) => {
			scheduled = flush;
			return () => {
				if (scheduled === flush) scheduled = null;
			};
		},
		pending: () => scheduled,
	};
}

test("batches consecutive session events in exact arrival order", () => {
	const delivered: (readonly SessionEventPayload[])[] = [];
	const scheduler = manualScheduler();
	const batcher = createSessionEventBatcher((events) => delivered.push(events), {
		schedule: scheduler.schedule,
	});
	const first = payload("a", "agent_start");
	const second = payload("b", "turn_start");

	batcher.enqueue(first);
	batcher.enqueue(second);
	expect(delivered).toEqual([]);
	expect(scheduler.pending()).not.toBeNull();
	scheduler.pending()?.();

	expect(delivered).toEqual([[first, second]]);
	expect(scheduler.pending()).toBeNull();
});

test("the queue ceiling forces a flush and disposal drops pending work", () => {
	const delivered: (readonly SessionEventPayload[])[] = [];
	const scheduler = manualScheduler();
	const batcher = createSessionEventBatcher((events) => delivered.push(events), {
		maxBatchSize: 2,
		schedule: scheduler.schedule,
	});
	const first = payload("a", "agent_start");
	const second = payload("a", "turn_start");
	const third = payload("a", "agent_end");

	batcher.enqueue(first);
	batcher.enqueue(second);
	expect(delivered).toEqual([[first, second]]);
	expect(scheduler.pending()).toBeNull();

	batcher.enqueue(third);
	expect(scheduler.pending()).not.toBeNull();
	batcher.dispose();
	scheduler.pending()?.();
	batcher.enqueue(first);
	batcher.flush();

	expect(delivered).toEqual([[first, second]]);
});

test("responses and non-session pushes form dispatch barriers", () => {
	const sessionPush = {
		channel: WS_CHANNELS.sessionEvent,
		data: payload("a", "agent_start"),
	} as WsServerMessage;
	const otherPush = {
		channel: WS_CHANNELS.workspaceFsChanged,
		data: {},
	} as WsServerMessage;
	const response = { id: "r1", ok: true, result: {} } as WsServerMessage;

	expect(shouldFlushSessionEventsBefore(sessionPush)).toBe(false);
	expect(shouldFlushSessionEventsBefore(otherPush)).toBe(true);
	expect(shouldFlushSessionEventsBefore(response)).toBe(true);
});

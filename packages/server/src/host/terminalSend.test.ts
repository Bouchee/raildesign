import { describe, expect, test } from "bun:test";
import { drainedClientKeys } from "./terminalSend";

describe("drainedClientKeys", () => {
	const buffered = new Map([
		["empty", 0],
		["busy", 4096],
	]);
	const bufferedAmount = (clientKey: string): number | undefined => buffered.get(clientKey);

	test("an empty socket buffer is the drain the OS never delivered", () => {
		expect(drainedClientKeys(["empty"], bufferedAmount)).toEqual(["empty"]);
	});

	test("real backpressure stays latched", () => {
		expect(drainedClientKeys(["busy"], bufferedAmount)).toEqual([]);
	});

	test("a client whose socket is gone is left to open/close to clear", () => {
		expect(drainedClientKeys(["empty", "busy", "closed"], bufferedAmount)).toEqual(["empty"]);
	});
});

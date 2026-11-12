import { describe, expect, test } from "bun:test";
import { assistantToolCallsAreExecutable } from "./sessionProtocol";

describe("assistantToolCallsAreExecutable", () => {
	test("rejects terminal reasons that cannot execute tool calls", () => {
		for (const stopReason of ["error", "aborted", "length"]) {
			expect(assistantToolCallsAreExecutable(stopReason)).toBe(false);
		}
	});

	test("allows executable and in-flight assistant states", () => {
		for (const stopReason of [undefined, "toolUse", "stop"]) {
			expect(assistantToolCallsAreExecutable(stopReason)).toBe(true);
		}
	});
});

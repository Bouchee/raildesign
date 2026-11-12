import { describe, expect, test } from "bun:test";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import { extractSession } from "./extract";

const record = (messages: unknown[], extra: Record<string, unknown> = {}) =>
	JSON.stringify({ version: 2, sessionId: "session-a", cwd: "/repo/a", messages, ...extra });

const user = (id: string, content: unknown, timestamp = 1) => ({
	id,
	role: "user",
	content,
	timestamp,
});

describe("extractSession", () => {
	test("keeps stable IDs and indices aligned with renderable transcript rows", () => {
		const json = record(
			[
				user("u1", "fix the test"),
				{
					id: "a1",
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private" },
						{ type: "text", text: "I found the cause." },
					],
					timestamp: 2,
				},
				{
					id: "tool1",
					role: "toolResult",
					content: [{ type: "text", text: "tool output" }],
					timestamp: 3,
				},
				{ id: "custom1", role: "custom", content: "custom display", timestamp: 4 },
				user("u2", [{ type: "text", text: "try again" }], 5),
			],
			{ title: "  My chat  ", history: [{ role: "system", content: "not searchable" }] },
		);
		expect(extractSession(json)).toEqual({
			id: "session-a",
			cwd: "/repo/a",
			title: "My chat",
			entries: [
				{ entryId: "u1", role: "user", text: "fix the test", timestamp: 1, messageIndex: 0 },
				{
					entryId: "a1",
					role: "assistant",
					text: "I found the cause.",
					timestamp: 2,
					messageIndex: 1,
				},
				{ entryId: "u2", role: "user", text: "try again", timestamp: 5, messageIndex: 4 },
			],
		});
	});

	test("keeps full text but skips controls, empty text, images and reasoning", () => {
		const text = `${"x".repeat(10000)} needle-at-the-end`;
		const result = extractSession(
			record([
				user("control", `${TODO_NUDGE_PREFIX}internal prompt`),
				user("empty", "  "),
				user("nontext", [
					{ type: "image", data: "x" },
					{ type: "text", text: 42 },
				]),
				user("full", text),
			]),
		);
		expect(result?.entries).toEqual([
			{ entryId: "full", role: "user", text, timestamp: 1, messageIndex: 3 },
		]);
	});

	test("rejects legacy records, malformed JSON, missing IDs and duplicate message IDs", () => {
		for (const value of [
			"not json",
			JSON.stringify({ type: "session", version: 3, id: "legacy", cwd: "/repo" }),
			record([user("a", "one")], { version: 1 }),
			record([{ role: "user", content: "no ID", timestamp: 1 }]),
			record([user("duplicate", "one"), user("duplicate", "two")]),
			record([], { sessionId: "../outside" }),
		])
			expect(extractSession(value)).toBeNull();
	});

	test("clearing a title leaves no stale name", () => {
		expect(extractSession(record([], { title: "  " }))?.title).toBeUndefined();
	});
});

import { expect, test } from "bun:test";
import { mcpServerLogLines } from "./log";

const LOG = [
	"2026-10-08T09:00:00.000Z [docs] info starting",
	"2026-10-08T09:00:01.000Z [docs-two] warning other server",
	"2026-10-08T09:00:02.000Z [docs] error fetch: failed",
	"    at connect (index.js:1)",
	"    ",
	"2026-10-08T09:00:03.000Z [other] info [docs] mentioned by another server",
	"    continuation of other",
	"stray line from a torn write",
	"    stray continuation",
	"",
].join("\n");

test("a server's log keeps its own entries and their continuation lines, never another server's", () => {
	expect(mcpServerLogLines(LOG, "docs")).toEqual([
		"2026-10-08T09:00:00.000Z [docs] info starting",
		"2026-10-08T09:00:02.000Z [docs] error fetch: failed",
		"    at connect (index.js:1)",
		"    ",
	]);
	expect(mcpServerLogLines(LOG, "docs-two")).toEqual([
		"2026-10-08T09:00:01.000Z [docs-two] warning other server",
	]);
	expect(mcpServerLogLines(LOG, "missing")).toEqual([]);
	expect(mcpServerLogLines("", "docs")).toEqual([]);
});

test("only the latest lines are kept", () => {
	const many = Array.from(
		{ length: 5 },
		(_, index) => `2026-10-08T09:00:0${index}.000Z [docs] info line ${index}`,
	).join("\n");
	expect(mcpServerLogLines(many, "docs", 2)).toEqual([
		"2026-10-08T09:00:03.000Z [docs] info line 3",
		"2026-10-08T09:00:04.000Z [docs] info line 4",
	]);
});

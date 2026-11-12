import { expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./toolOutput";

test("tool output preserves complete UTF-8 lines within both limits", () => {
	expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
	expect(DEFAULT_MAX_LINES).toBe(2000);
	expect(truncateHead("一\n二\n三", { maxBytes: 7 })).toMatchObject({
		content: "一\n二",
		truncated: true,
		truncatedBy: "bytes",
		outputBytes: 7,
		outputLines: 2,
	});
	expect(truncateHead("一\n二\n三", { maxLines: 1 })).toMatchObject({
		content: "一",
		truncatedBy: "lines",
	});
	expect(truncateHead("🧪", { maxBytes: 3 })).toMatchObject({
		content: "",
		firstLineExceedsLimit: true,
		outputLines: 0,
	});
});

test("tool output retains trailing newlines when no truncation is necessary", () => {
	expect(truncateHead("a\n", { maxLines: 1, maxBytes: 2 })).toMatchObject({
		content: "a\n",
		totalLines: 1,
		truncated: false,
	});
	expect(truncateHead("")).toMatchObject({ content: "", totalLines: 0, totalBytes: 0 });
});

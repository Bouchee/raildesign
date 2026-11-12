import { expect, test } from "bun:test";
import type { TranscriptMessage } from "@thinkrail/contracts";
import {
	assistantText,
	isSkillLoad,
	splitAtCompaction,
	toolCalls,
} from "../e2e/fixtures/skillCompaction";

const user = (content: string): TranscriptMessage => ({ role: "user", content, timestamp: 0 });
const summary = (text: string): Extract<TranscriptMessage, { role: "compactionSummary" }> => ({
	role: "compactionSummary",
	summary: text,
	tokensBefore: 100,
	timestamp: 0,
});
const assistant: TranscriptMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "visible" },
		{
			type: "toolCall",
			id: "read-1",
			name: "read",
			arguments: { path: ".agents/skills/release-ledger/SKILL.md" },
		},
	],
	api: "responses",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 0,
};

test("transcript helpers extract visible text and read attempts without exposing hidden reasoning", () => {
	expect(assistantText(assistant)).toBe("visible");
	expect(toolCalls(assistant).map(({ name }) => name)).toEqual(["read"]);
	expect(isSkillLoad(assistant, "release-ledger")).toBe(true);
	expect(isSkillLoad(assistant, "ledger")).toBe(false);
	expect(
		isSkillLoad(
			user(
				'<skill name="release-ledger" location="/skills/release-ledger/SKILL.md">Body</skill>\nContinue.',
			),
			"release-ledger",
		),
	).toBe(true);
	expect(assistantText(user("visible"))).toBe("");
});

test("repeated compactions split at the latest owned summary without fabricating a retained cut", () => {
	const earlier = summary("first"),
		latest = summary("second"),
		after = user("phase C");
	const split = splitAtCompaction([user("phase A"), earlier, user("phase B"), latest, after]);
	expect(split.before).toHaveLength(3);
	expect(split.compaction).toBe(latest);
	expect(split.after).toEqual([after]);
	expect(() => splitAtCompaction([after])).toThrow("no compaction summary");
});

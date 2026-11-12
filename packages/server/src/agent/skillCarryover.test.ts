import { expect, test } from "bun:test";
import type { TranscriptMessage } from "@thinkrail/contracts";
import {
	carryoverBudget,
	compactedSkills,
	SKILL_CARRYOVER_CUSTOM_TYPE,
	skillCarryoverText,
	withSkillCarryover,
} from "./skillCarryover";
import type { Skill } from "./skills";

function skill(name: string): Skill {
	return {
		name,
		description: name,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			path: `/skills/${name}/SKILL.md`,
			source: "raildesign",
			scope: "user",
			origin: "top-level",
		},
		disableModelInvocation: false,
	};
}

test("carryover respects both the dispatched window and per-Skill and total caps", () => {
	expect(carryoverBudget({ contextWindow: 1_000_000 })).toEqual({
		skillChars: 20_000,
		totalChars: 100_000,
	});
	expect(carryoverBudget({ contextWindow: 128_000 })).toEqual({
		skillChars: 20_000,
		totalChars: 51_200,
	});
	expect(carryoverBudget({ contextWindow: 32_000 })).toEqual({
		skillChars: 12_800,
		totalChars: 12_800,
	});
	expect(carryoverBudget({ contextWindow: 0 })).toBeUndefined();
	expect(carryoverBudget(undefined)).toBeUndefined();
});

test("bounded carryover prioritizes recent loads and marks omitted body text", () => {
	const skills = [skill("oldest"), skill("recent"), skill("newest")];
	const rendered = skillCarryoverText(skills, { skillChars: 500, totalChars: 1_000 }, () =>
		"body ".repeat(1_000),
	);
	expect(rendered?.length).toBeLessThanOrEqual(1_000);
	expect(rendered).toContain('name="newest"');
	expect(rendered).not.toContain('name="oldest"');
	expect(rendered).toContain("Truncated after compaction");
});

test("unreadable Skills are skipped and tiny budgets cannot invent content", () => {
	expect(
		skillCarryoverText([skill("gone")], { skillChars: 100, totalChars: 1_000 }),
	).toBeUndefined();
	expect(
		skillCarryoverText([skill("tiny")], { skillChars: 100, totalChars: 5 }, () => "body"),
	).toBeUndefined();
});

test("carryover uses current transcript types and sits directly after the compaction summary", () => {
	const summary: TranscriptMessage = {
		role: "compactionSummary",
		summary: "Earlier work",
		tokensBefore: 100,
		timestamp: 10,
	};
	const next: TranscriptMessage = { role: "user", content: "Continue", timestamp: 20 };
	const messages = withSkillCarryover([summary, next], "restored");
	expect(messages?.map(({ role }) => role)).toEqual(["compactionSummary", "custom", "user"]);
	expect(messages?.[1]).toMatchObject({
		customType: SKILL_CARRYOVER_CUSTOM_TYPE,
		content: "restored",
		display: false,
		timestamp: 10,
	});
	expect(withSkillCarryover([next], "restored")).toBeUndefined();
	expect(withSkillCarryover([summary], undefined)).toBeUndefined();
});

const userSkill = (name: string): TranscriptMessage => ({
	role: "user",
	content: `<skill name="${name}" location="/skills/${name}/SKILL.md">Body</skill>\nContinue`,
	timestamp: 0,
});
const evidenceRead = (
	id: string,
	name: string,
	window: { offset?: number; limit?: number } = {},
): TranscriptMessage => ({
	role: "assistant",
	api: "responses",
	provider: "test",
	model: "test",
	content: [
		{ type: "toolCall", id, name: "read", arguments: { path: `${name}/SKILL.md`, ...window } },
	],
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
});
const evidenceResult = (id: string, isError = false, details?: unknown): TranscriptMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "body" }],
	isError,
	details,
	timestamp: 0,
});

test("retained-cut analysis restores only previously loaded admitted Skills and respects complete retained reads", () => {
	const ledger = skill("ledger"),
		todos = skill("todos");
	const messages = [
		userSkill("ledger"),
		evidenceRead("r1", "todos"),
		evidenceResult("r1"),
		evidenceRead("r2", "ledger"),
		evidenceResult("r2"),
	];
	expect(compactedSkills(messages, [ledger, todos], "/skills", 3)).toEqual([todos]);
	expect(
		compactedSkills(
			[evidenceRead("failed", "ledger"), evidenceResult("failed", true), userSkill("unadmitted")],
			[ledger],
			"/skills",
			3,
		),
	).toEqual([]);
	expect(compactedSkills(messages, [ledger, todos], "/skills", 0)).toEqual([]);
	expect(() => compactedSkills(messages, [ledger], "/skills", -1)).toThrow(
		"retained transcript cut",
	);
});

test("partial, truncated and gapped retained reads cannot conceal a lost full Skill body", () => {
	const ledger = skill("ledger");
	const partial = [
		userSkill("ledger"),
		evidenceRead("r1", "ledger", { offset: 1, limit: 2 }),
		evidenceResult("r1"),
	];
	expect(compactedSkills(partial, [ledger], "/skills", 1, () => 4)).toEqual([ledger]);
	const complete = [
		...partial,
		evidenceRead("r2", "ledger", { offset: 3, limit: 2 }),
		evidenceResult("r2"),
	];
	expect(compactedSkills(complete, [ledger], "/skills", 1, () => 4)).toEqual([]);
	const gap = [
		...partial,
		evidenceRead("r2", "ledger", { offset: 4, limit: 1 }),
		evidenceResult("r2"),
	];
	expect(compactedSkills(gap, [ledger], "/skills", 1, () => 4)).toEqual([ledger]);
	const truncated = [
		userSkill("ledger"),
		evidenceRead("r1", "ledger"),
		evidenceResult("r1", false, { truncation: { truncated: true, outputLines: 1 } }),
	];
	expect(compactedSkills(truncated, [ledger], "/skills", 1, () => 4)).toEqual([ledger]);
});

test("selection preserves latest-load order and survives a second committed cut without a new read", () => {
	const ledger = skill("ledger"),
		todos = skill("todos");
	const history: TranscriptMessage[] = [
		userSkill("ledger"),
		userSkill("todos"),
		userSkill("ledger"),
		{ role: "compactionSummary", summary: "first", tokensBefore: 100, timestamp: 1 },
		{ role: "user", content: "phase B", timestamp: 2 },
		{ role: "compactionSummary", summary: "second", tokensBefore: 100, timestamp: 3 },
	];
	expect(compactedSkills(history, [ledger, todos], "/skills", 3)).toEqual([todos, ledger]);
	expect(compactedSkills(history, [ledger, todos], "/skills", 5)).toEqual([todos, ledger]);
	const restored = withSkillCarryover(history, "restored");
	expect(restored?.at(-1)).toMatchObject({ role: "custom", content: "restored", timestamp: 3 });
});

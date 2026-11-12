import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { TranscriptMessage, WireModel } from "@thinkrail/contracts";
import { parseSkillBlock, readSkillBody, type Skill } from "./skills";

function safeBody(skill: Skill): string | undefined {
	try {
		return readSkillBody(skill);
	} catch {
		return undefined;
	}
}

export const SKILL_CARRYOVER_CUSTOM_TYPE = "raildesign/skill-carryover";
const SKILL_CARRYOVER_SKILL_TOKENS = 5_000;
const SKILL_CARRYOVER_TOTAL_TOKENS = 25_000;
const SKILL_CARRYOVER_WINDOW_SHARE = 0.1;

const CHARS_PER_TOKEN = 4;
const SEPARATOR = "\n\n";

export const SKILL_CARRYOVER_PREAMBLE =
	"Context compaction summarized the earlier conversation, including the text of skills loaded in it. Those skills are restored below, most recently loaded last. Keep applying the ones that bear on the current work; if one you are following is marked truncated, read its file before relying on the missing part.";

export interface CarryoverBudget {
	skillChars: number;
	totalChars: number;
}

export function carryoverBudget(
	model: Pick<WireModel, "contextWindow"> | undefined,
): CarryoverBudget | undefined {
	if (!model || !(model.contextWindow > 0)) return undefined;
	const totalTokens = Math.min(
		SKILL_CARRYOVER_TOTAL_TOKENS,
		Math.floor(model.contextWindow * SKILL_CARRYOVER_WINDOW_SHARE),
	);
	return {
		skillChars: Math.min(SKILL_CARRYOVER_SKILL_TOKENS, totalTokens) * CHARS_PER_TOKEN,
		totalChars: totalTokens * CHARS_PER_TOKEN,
	};
}

function texts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) =>
		part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
	);
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function readTarget(path: string, cwd: string): string {
	return canonicalPath(resolve(cwd, path));
}

interface LineRange {
	start: number;
	end: number;
}

interface ReadLoad {
	skill: Skill;
	start: number;
	limit: number | undefined;
}

interface SkillLoad {
	skill: Skill;
	index: number;
	lines: LineRange;
}

const WHOLE_FILE: LineRange = { start: 0, end: Number.POSITIVE_INFINITY };

function readLines(read: ReadLoad, details: unknown): LineRange {
	const truncation = (details as { truncation?: { truncated?: unknown; outputLines?: unknown } })
		?.truncation;
	if (truncation?.truncated === true) {
		const shown = typeof truncation.outputLines === "number" ? truncation.outputLines : 0;
		return { start: read.start, end: read.start + shown };
	}
	const end = read.limit === undefined ? Number.POSITIVE_INFINITY : read.start + read.limit;
	return { start: read.start, end };
}

function covers(ranges: readonly LineRange[], lineCount: number): boolean {
	let reach = 0;
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.start > reach) break;
		reach = Math.max(reach, range.end);
	}
	return reach >= lineCount;
}

function skillLoads(
	entries: readonly TranscriptMessage[],
	skills: readonly Skill[],
	cwd: string,
): SkillLoad[] {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const byPath = new Map(skills.map((skill) => [canonicalPath(resolve(skill.filePath)), skill]));
	const reads = new Map<string, ReadLoad>();
	const loads: SkillLoad[] = [];
	entries.forEach((message, index) => {
		if (message.role === "user") {
			for (const text of texts(message.content)) {
				const block = parseSkillBlock(text);
				const skill = block && byName.get(block.name);
				if (skill) loads.push({ skill, index, lines: WHOLE_FILE });
			}
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "read") continue;
				const args = part.arguments as { path?: unknown; offset?: unknown; limit?: unknown };
				if (typeof args.path !== "string") continue;
				const target = readTarget(args.path, cwd);
				const skill = target && byPath.get(target);
				if (skill)
					reads.set(part.id, {
						skill,
						start: typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0,
						limit: typeof args.limit === "number" ? args.limit : undefined,
					});
			}
		} else if (message.role === "toolResult" && !message.isError) {
			const read = reads.get(message.toolCallId);
			if (read) loads.push({ skill: read.skill, index, lines: readLines(read, message.details) });
		}
	});
	return loads;
}

/** Pure retained-tail analysis. The compaction transaction supplies its committed cut; no journal is read. */
export function compactedSkills(
	entries: readonly TranscriptMessage[],
	skills: readonly Skill[],
	cwd: string,
	retainedFrom: number,
	lineCount: (skill: Skill) => number | undefined = () => undefined,
): Skill[] {
	if (!Number.isInteger(retainedFrom) || retainedFrom < 0 || retainedFrom > entries.length)
		throw new RangeError("Invalid retained transcript cut");
	const cut = retainedFrom;
	const loads = skillLoads(entries, skills, cwd);
	const latest = new Map<Skill, number>();
	for (const load of loads) latest.set(load.skill, load.index);
	const retained = (skill: Skill) =>
		covers(
			loads.filter((load) => load.skill === skill && load.index >= cut).map((load) => load.lines),
			lineCount(skill) ?? Number.POSITIVE_INFINITY,
		);
	return [...latest]
		.filter(([skill]) => loads.some((load) => load.skill === skill && load.index < cut))
		.filter(([skill]) => !retained(skill))
		.sort(([, a], [, b]) => a - b)
		.map(([skill]) => skill);
}

export function skillCarryoverText(
	skills: readonly Skill[],
	budget: CarryoverBudget,
	readBody: (skill: Skill) => string | undefined = safeBody,
): string | undefined {
	const blocks: string[] = [];
	let used = SKILL_CARRYOVER_PREAMBLE.length;
	for (const skill of [...skills].reverse()) {
		const open = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n`;
		const close = "\n</skill>";
		const room = budget.totalChars - used - SEPARATOR.length - open.length - close.length;
		if (room <= 0) continue;
		const body = readBody(skill);
		if (body === undefined) continue;
		const notice = `\n\n[Truncated after compaction. Read ${skill.filePath} for the full text.]`;
		const keep = Math.min(budget.skillChars, room - notice.length);
		const text =
			body.length <= Math.min(budget.skillChars, room)
				? body
				: keep > 0
					? `${body.slice(0, keep)}${notice}`
					: undefined;
		if (text === undefined) continue;
		const block = `${open}${text}${close}`;
		used += SEPARATOR.length + block.length;
		blocks.unshift(block);
	}
	return blocks.length > 0 ? [SKILL_CARRYOVER_PREAMBLE, ...blocks].join(SEPARATOR) : undefined;
}

export function withSkillCarryover(
	messages: TranscriptMessage[],
	text: string | undefined,
): TranscriptMessage[] | undefined {
	const summary = messages.findLastIndex((message) => message.role === "compactionSummary");
	if (text === undefined || summary < 0) return undefined;
	const carryover: TranscriptMessage = {
		role: "custom",
		customType: SKILL_CARRYOVER_CUSTOM_TYPE,
		content: text,
		display: false,
		timestamp: messages[summary]?.timestamp ?? Date.now(),
	};
	return [...messages.slice(0, summary + 1), carryover, ...messages.slice(summary + 1)];
}

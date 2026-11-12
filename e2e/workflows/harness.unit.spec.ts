import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { AskUserQuestionItem } from "@thinkrail/ask-user-question/core";
import type { SessionEvent } from "@thinkrail/contracts";
import {
	checkBudget,
	checks,
	DEFAULT_BUDGET,
	EventLog,
	FIXTURE_MD_SUFFIX,
	includeInFixtureSnapshot,
	maskFixtureMarkdown,
	parseJudgeReply,
	parseOnTrackReply,
	parsePersonaReply,
	parseSimReply,
	pickRecommended,
	runChecks,
	signals,
	skipAll,
	unmaskFixtureMarkdown,
	watchSignals,
} from "./harness";

const SKILLS = "/repo/packages/pi-thinkrail-workflow/skills";

function toolStart(id: string, name: string, args: Record<string, unknown>): SessionEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName: name, args } as SessionEvent;
}
function toolEnd(id: string, name: string, result: unknown): SessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result,
		isError: false,
	} as SessionEvent;
}
function turnEnd(): SessionEvent {
	return { type: "agent_settled", terminal: { stopReason: "stop" } };
}

function routedLog(): EventLog {
	const log = new EventLog();
	log.push(toolStart("t1", "read", { path: `${SKILLS}/choosing-a-workflow/SKILL.md` }));
	log.push(toolEnd("t1", "read", "…"));
	log.push(toolStart("t2", "read", { path: `${SKILLS}/brainstorming/SKILL.md` }));
	log.push(toolEnd("t2", "read", "…"));
	log.push(turnEnd());
	return log;
}

test("EventLog: tool calls, skill reads, turn count", () => {
	const log = routedLog();
	expect(log.toolCalls("read")).toHaveLength(2);
	expect(log.skillReads()).toEqual(["choosing-a-workflow", "brainstorming"]);
	expect(log.turnCount()).toBe(1);
	log.push(toolStart("t3", "read", { path: "/repo/README.md" }));
	expect(log.skillReads()).toHaveLength(2);
});

test("signals: skillRead + turnEnd; forbid wins over stop", async () => {
	const log = new EventLog();
	const watcher = watchSignals(
		log,
		[signals.skillRead("brainstorming")],
		[signals.skillRead("importing-a-codebase")],
	);
	log.push(toolStart("a", "read", { path: `${SKILLS}/importing-a-codebase/SKILL.md` }));
	log.push(toolStart("b", "read", { path: `${SKILLS}/brainstorming/SKILL.md` }));
	const hit = await watcher.hit;
	expect(hit.kind).toBe("forbid");
	watcher.cancel();
});

const QUESTIONS: AskUserQuestionItem[] = [
	{
		question: "Which log format?",
		header: "Format",
		options: [
			{ label: "Plain text (Recommended)", description: "simple lines" },
			{ label: "JSON objects", description: "machine-readable" },
		],
	},
];

test("dialog: pickRecommended, skipAll, persona reply parsing", () => {
	const recommended = pickRecommended(QUESTIONS);
	expect(recommended.cancelled).toBe(false);
	expect(recommended.answers[0]?.answer).toBe("Plain text (Recommended)");
	expect(skipAll().cancelled).toBe(true);

	const ok = parsePersonaReply(
		'Sure: {"answers":[{"questionIndex":0,"answer":"JSON objects"}]}',
		QUESTIONS,
	);
	expect(ok?.answers[0]?.answer).toBe("JSON objects");
	expect(
		parsePersonaReply('{"answers":[{"questionIndex":0,"answer":"Nope"}]}', QUESTIONS),
	).toBeNull();
	expect(
		parsePersonaReply('{"answers":[{"questionIndex":9,"answer":"JSON objects"}]}', QUESTIONS),
	).toBeNull();
	expect(parsePersonaReply("not json at all", QUESTIONS)).toBeNull();
});

test("watchdog: budget tripwires + on-track parsing", () => {
	const log = routedLog();
	const now = Date.now();
	expect(checkBudget(log, now, DEFAULT_BUDGET, now)).toBeNull();
	expect(checkBudget(log, now, { ...DEFAULT_BUDGET, maxTurns: 1 }, now)).toContain("turns");
	expect(checkBudget(log, now, { ...DEFAULT_BUDGET, maxToolCalls: 2 }, now)).toContain(
		"tool calls",
	);
	expect(checkBudget(log, now - 10_000, { ...DEFAULT_BUDGET, maxMs: 5_000 }, now)).toContain(
		"wall time",
	);

	expect(parseOnTrackReply('{"onTrack": false, "reason": "looping"}')).toEqual({
		onTrack: false,
		reason: "looping",
	});
	expect(parseOnTrackReply("garbage").onTrack).toBe(true);
});

test("userSim + judge reply parsing", () => {
	expect(parseSimReply("DONE")).toBeNull();
	expect(parseSimReply("  done ")).toBeNull();
	expect(parseSimReply("Plain text please.")).toBe("Plain text please.");

	const rubric = ["named the route", "did not implement"];
	const parsed = parseJudgeReply(
		'[{"statement":"named the route","verdict":"pass","evidence":"quote"},{"statement":"did not implement","verdict":"fail","evidence":"edited foo.ts"}]',
		rubric,
	);
	expect(parsed.map((i) => i.verdict)).toEqual(["pass", "fail"]);
	expect(parseJudgeReply("no json here", rubric).every((i) => i.verdict === "unclear")).toBe(true);
});

test("presets: fixture snapshot filter drops only the .git directory", () => {
	expect(includeInFixtureSnapshot("/ws/.git")).toBe(false);
	expect(includeInFixtureSnapshot("/ws/.git/config")).toBe(false);
	expect(includeInFixtureSnapshot("/ws/.gitignore")).toBe(true);
	expect(includeInFixtureSnapshot("/ws/.github/workflows/ci.yml")).toBe(true);
	expect(includeInFixtureSnapshot("/ws/src/index.ts")).toBe(true);
});

test("presets: fixture markdown mask/unmask round-trip", () => {
	const dir = join(tmpdir(), `workflow-fixture-mask-${Date.now()}`);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "SPEC.md"), "---\nid: fixture-spec\ntype: module-design\n---\n");
	writeFileSync(join(dir, "src", "notes.md"), "plain");
	writeFileSync(join(dir, "src", "index.ts"), "export {};\n");

	maskFixtureMarkdown(dir);
	expect(existsSync(join(dir, "SPEC.md"))).toBe(false);
	expect(existsSync(join(dir, `SPEC.md${FIXTURE_MD_SUFFIX}`))).toBe(true);
	expect(existsSync(join(dir, "src", `notes.md${FIXTURE_MD_SUFFIX}`))).toBe(true);
	expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);

	unmaskFixtureMarkdown(dir);
	expect(existsSync(join(dir, `SPEC.md${FIXTURE_MD_SUFFIX}`))).toBe(false);
	expect(readFileSync(join(dir, "SPEC.md"), "utf8")).toContain("id: fixture-spec");
	expect(existsSync(join(dir, "src", "notes.md"))).toBe(true);
});

test("checks: skill ordering, tool discipline, files, spec frontmatter", () => {
	const cwd = join(tmpdir(), `workflow-harness-unit-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "TASK-x.md"), "---\nid: task-x\ntype: task-spec\n---\n\n## Request\n");
	writeFileSync(join(cwd, "notes.md"), "no frontmatter");
	const log = routedLog();
	log.push(toolStart("e1", "edit", { path: "/repo/src/main.ts" }));

	const results = runChecks(
		[
			checks.expectSkillRead("choosing-a-workflow"),
			checks.expectOrdering("choosing-a-workflow", "brainstorming"),
			checks.expectNoSkillRead(["importing-a-codebase"]),
			checks.expectToolCalled("edit"),
			checks.expectToolNotCalled("edit", { pathEndsWith: "TASK-x.md" }),
			checks.expectFile("TASK-x.md", /## Request/),
			checks.expectSpecValid("TASK-x.md"),
		],
		{ log, cwd },
	);
	expect(results.filter((r) => !r.pass)).toEqual([]);

	const failing = runChecks(
		[
			checks.expectOrdering("brainstorming", "choosing-a-workflow"),
			checks.expectSpecValid("notes.md"),
			checks.expectFile("missing.md"),
		],
		{ log, cwd },
	);
	expect(failing.every((r) => !r.pass)).toBe(true);
});

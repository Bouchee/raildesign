import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	type AskUserQuestionResult,
	isAskUserQuestionResult,
} from "@thinkrail/ask-user-question/core";
import { gitText } from "../fixtures/git";
import { E2eWire } from "../fixtures/wire";
import {
	type Check,
	checks,
	driveTurn,
	openSeededSession,
	runChecks,
	signals,
	type TurnOptions,
	type WorkspaceKind,
} from "./harness";

const SETUP_WORKERS = ["starting-a-new-project", "importing-a-codebase"];
const REVIEW_REFUSAL =
	"Do not review or extend anything. Do not proceed; leave all files unchanged.";
const DIRECT_WORK_FORBIDDEN_SKILLS = [
	"choosing-a-workflow",
	"brainstorming",
	"setting-up-a-project",
	"shipping-a-pr",
	"spec-graph",
	"todos",
	...SETUP_WORKERS,
];
const DIRECT_WORK_FORBIDDEN_TOOLS = [
	"spec_search",
	"spec_grep",
	"spec_get",
	"spec_graph",
	"spec_create",
	"spec_update",
	"spec_delete",
	"spec_validate",
	"todo_list",
	"todo_write",
	"todo_add",
	"todo_update",
	"todo_remove",
	"todo_plan_summary",
	"todo_promote",
];

const noPatch = checks.expectToolNotCalled("apply_patch");
const noChange = checks.custom(
	"the worktree is unchanged",
	({ cwd }) => gitText(cwd, "status", "--porcelain") === "",
);
const routeToBrainstorming = [
	checks.expectSkillRead("choosing-a-workflow"),
	checks.expectOrdering("choosing-a-workflow", "brainstorming"),
	noPatch,
	noChange,
];
const directWorkForbid = [
	...DIRECT_WORK_FORBIDDEN_SKILLS.map((name) => signals.skillRead(name)),
	...DIRECT_WORK_FORBIDDEN_TOOLS.map((name) => signals.toolCall(name)),
];
const directWorkChecks = [
	checks.expectNoSkillRead(DIRECT_WORK_FORBIDDEN_SKILLS),
	...DIRECT_WORK_FORBIDDEN_TOOLS.map((name) => checks.expectToolNotCalled(name)),
];
const bugBranch = {
	where: (call: { args: Record<string, unknown>; result?: unknown; isError?: boolean }) =>
		call.args.name === "brainstorming" &&
		call.args.path === "fixing-a-bug.md" &&
		call.result !== undefined &&
		!call.isError,
};

interface RoutingCase extends TurnOptions {
	id: string;
	name: string;
	workspace: WorkspaceKind;
	prompt: string;
	checks: Check[];
}

const cases: RoutingCase[] = [
	{
		id: "R1",
		name: "root router: decision-bearing feature request routes to brainstorming",
		workspace: "code-only",
		prompt:
			"Add progress reporting to the CLI for both humans and automation. I have not decided " +
			"the output format, default behavior, or compatibility contract yet.",
		stopWhen: [signals.skillRead("brainstorming")],
		forbid: SETUP_WORKERS.map((name) => signals.skillRead(name)),
		checks: routeToBrainstorming,
	},
	{
		id: "R2",
		name: "root router: a small, explicitly specified behavior change still routes to brainstorming",
		workspace: "code-only",
		prompt:
			"Add a --quiet flag to the CLI that suppresses all output. Exit codes stay exactly as they are.",
		stopWhen: [signals.skillRead("brainstorming")],
		forbid: SETUP_WORKERS.map((name) => signals.skillRead(name)),
		checks: routeToBrainstorming,
	},
	{
		id: "R3",
		name: "root router: a bug report routes to brainstorming's bug branch before any fix",
		workspace: "code-only",
		prompt:
			"Bug: running the CLI with no image paths silently does nothing. It should print a usage " +
			"message and exit with code 1.",
		stopWhen: [signals.toolCall("skill_read", bugBranch)],
		forbid: SETUP_WORKERS.map((name) => signals.skillRead(name)),
		checks: [...routeToBrainstorming, checks.expectToolCalled("skill_read", bugBranch)],
	},
	{
		id: "R4",
		name: "root router: PR checks route to shipping-a-pr",
		workspace: "code-only",
		prompt: "Check CI on PR #42 and investigate any failing checks.",
		stopWhen: [signals.skillRead("shipping-a-pr")],
		forbid: ["brainstorming", "setting-up-a-project"].map((name) => signals.skillRead(name)),
		checks: [
			checks.expectSkillRead("choosing-a-workflow"),
			checks.expectOrdering("choosing-a-workflow", "shipping-a-pr"),
			noPatch,
			noChange,
		],
	},
	{
		id: "R5",
		name: "root router: raw idea in an empty workspace routes to the setup family",
		workspace: "empty",
		prompt:
			"I have an idea for a brand-new project: a tiny web app that tracks my houseplants' " +
			"watering schedule. Let's get it going.",
		stopWhen: ["setting-up-a-project", "starting-a-new-project"].map((name) =>
			signals.skillRead(name),
		),
		forbid: ["brainstorming", "importing-a-codebase"].map((name) => signals.skillRead(name)),
		checks: [
			checks.custom("routed into the setup family", ({ log }) =>
				log
					.skillReads()
					.some((name) => name === "setting-up-a-project" || name === "starting-a-new-project"),
			),
			noPatch,
			noChange,
		],
	},
	{
		id: "R6",
		name: "direct work: a pure question bypasses workflows and gets answered directly",
		workspace: "code-only",
		prompt: "What does this codebase do? Give me a short overview of its modules.",
		forbid: directWorkForbid,
		checks: [
			...directWorkChecks,
			checks.custom("the answer describes the image-resizing codebase", ({ log }) =>
				/resiz/i.test(log.assistantTexts().join("\n")),
			),
			noPatch,
			noChange,
		],
	},
	{
		id: "R7",
		name: "direct work: a localized fully specified edit bypasses workflows",
		workspace: "code-only",
		prompt:
			"In src/resize/index.ts rename the files parameter to imagePaths without changing " +
			"behavior. Make no other changes.",
		forbid: directWorkForbid,
		allowConfirm: (call) =>
			call.toolName === "apply_patch" && call.args.path === "src/resize/index.ts",
		checks: [
			...directWorkChecks,
			checks.custom(
				"only the requested file changed",
				({ cwd }) => gitText(cwd, "status", "--porcelain") === " M src/resize/index.ts\n",
			),
			checks.expectFile(
				"src/resize/index.ts",
				/resize\(imagePaths: string\[\]\)[\s\S]*void imagePaths/,
			),
			checks.custom(
				"the edit only renames the parameter",
				({ cwd }) =>
					existsSync(join(cwd, "src/resize/index.ts")) &&
					readFileSync(join(cwd, "src/resize/index.ts"), "utf8") ===
						gitText(cwd, "show", "HEAD:src/resize/index.ts").replaceAll("files", "imagePaths"),
			),
		],
	},
	{
		id: "R8",
		name: "dispatcher: empty workspace routes to starting-a-new-project",
		workspace: "empty",
		prompt:
			"/skill:setting-up-a-project I want to start a brand-new project here: a CLI that renames photos by their EXIF date.",
		stopWhen: [signals.skillRead("starting-a-new-project")],
		forbid: ["importing-a-codebase", "brainstorming"].map((name) => signals.skillRead(name)),
		checks: [
			checks.expectSkillRead("starting-a-new-project"),
			checks.expectNoSkillRead(["importing-a-codebase"]),
			noPatch,
			noChange,
		],
	},
	{
		id: "R9",
		name: "dispatcher: code-only workspace routes to importing-a-codebase",
		workspace: "code-only",
		prompt: "/skill:setting-up-a-project This is an existing codebase without specs — set it up.",
		stopWhen: [signals.skillRead("importing-a-codebase")],
		forbid: ["starting-a-new-project", "brainstorming"].map((name) => signals.skillRead(name)),
		checks: [
			checks.expectSkillRead("importing-a-codebase"),
			checks.expectNoSkillRead(["starting-a-new-project"]),
			noPatch,
			noChange,
		],
	},
	{
		id: "R10",
		name: "dispatcher: specced workspace gets the review/extend offer, no setup worker",
		workspace: "specced",
		prompt: "/skill:setting-up-a-project Set up this project.",
		forbid: [...SETUP_WORKERS, "brainstorming"].map((name) => signals.skillRead(name)),
		answer: (call): AskUserQuestionResult => {
			const questions = call.args.questions;
			if (!Array.isArray(questions) || questions.length === 0)
				throw new Error("The review offer has no questions");
			return {
				cancelled: false,
				answers: questions.map((item: unknown, questionIndex) => {
					if (
						typeof item !== "object" ||
						item === null ||
						!("question" in item) ||
						typeof item.question !== "string"
					)
						throw new Error("The review offer has no question text");
					return { questionIndex, question: item.question, kind: "custom", answer: REVIEW_REFUSAL };
				}),
			};
		},
		checks: [
			checks.expectNoSkillRead([...SETUP_WORKERS, "brainstorming"]),
			checks.expectToolNotCalled("spec_create"),
			checks.custom("the reply offers to review or extend the existing specs", ({ log }) =>
				log
					.assistantTexts()
					.some((text) => /(?:review|extend)/i.test(text) && /(?:spec|graph)/i.test(text)),
			),
			checks.custom("no effectful tool follows a declined offer", ({ log }) => {
				const declinedCalls = new Set<string>();
				for (const event of log.events) {
					if (event.type === "tool_execution_end" && event.toolName === "ask_user_question") {
						const questions = log
							.toolCalls("ask_user_question")
							.find((call) => call.toolCallId === event.toolCallId)?.args.questions;
						const details =
							event.result && typeof event.result === "object" && "details" in event.result
								? event.result.details
								: null;
						if (
							event.isError ||
							!isAskUserQuestionResult(details) ||
							details.cancelled ||
							!Array.isArray(questions) ||
							questions.length === 0 ||
							details.answers.length !== questions.length ||
							details.answers.some(
								(answer, index) =>
									answer?.questionIndex !== index ||
									answer.question !== questions[index]?.question ||
									answer.kind !== "custom" ||
									answer.answer !== REVIEW_REFUSAL,
							)
						)
							return false;
						declinedCalls.add(event.toolCallId);
					}
					if (
						declinedCalls.size > 0 &&
						event.type === "tool_execution_start" &&
						![
							"read",
							"search",
							"skill_read",
							"spec_search",
							"spec_grep",
							"spec_get",
							"spec_graph",
						].includes(event.toolName)
					)
						return false;
				}
				return log
					.toolCalls("ask_user_question")
					.every((call) => declinedCalls.has(call.toolCallId));
			}),
			noPatch,
			noChange,
		],
	},
];

for (const scenario of cases) {
	test(`${scenario.id}: ${scenario.name}`, { tag: "@agent" }, async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const wire = await E2eWire.connect();
		try {
			const session = await openSeededSession(page, wire, scenario.workspace);
			const turn = await driveTurn(wire, session, scenario.prompt, {
				...scenario,
				allowConfirm: (call) =>
					call.toolName === "bash" ? undefined : (scenario.allowConfirm?.(call) ?? false),
			});
			const results = runChecks(scenario.checks, { log: turn.log, cwd: session.cwd });
			await testInfo.attach("routing-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify({
						case: scenario.id,
						sourceCommit: gitText(process.cwd(), "rev-parse", "HEAD").trim(),
						sourceStatus: gitText(process.cwd(), "status", "--porcelain"),
						session,
						...turn,
						log: turn.log.renderTranscript(),
						results,
						gitStatus: gitText(session.cwd, "status", "--porcelain"),
						gitDiff: gitText(session.cwd, "diff", "HEAD"),
					}),
				),
			});
			expect(turn.failure, turn.log.renderTranscript()).toBeNull();
			expect(results.filter((result) => !result.pass)).toEqual([]);
		} finally {
			wire.close();
		}
	});
}

import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	type AskUserQuestionResult,
	isAskUserQuestionArgs,
} from "@thinkrail/ask-user-question/core";
import { parseFile, scalar } from "@thinkrail/spec-graph/core";
import { checks } from "./checks";
import type { CapturedToolCall } from "./events";
import { includeInFixtureSnapshot, unmaskFixtureMarkdown } from "./presets";

export const RESUME_TASK_PATH = ".thinkrail/context/TASK-verbose-logging.md";
export const RESUME_FORMAT_ANSWER =
	"Plain-text log lines, not JSON. I confirm only this log-format choice. Record it without adding " +
	"any other requirements or decisions, including future compatibility contracts. Then stop; do not implement.";

export function seedResumeWorkspace(cwd: string): void {
	cpSync(
		fileURLToPath(new URL("../fixtures/brainstorming-mid-flow/workspace", import.meta.url)),
		cwd,
		{
			recursive: true,
			filter: includeInFixtureSnapshot,
		},
	);
	unmaskFixtureMarkdown(cwd);
}

export function answerResumeQuestion(call: CapturedToolCall): AskUserQuestionResult {
	if (!isAskUserQuestionArgs(call.args) || call.args.questions.length !== 1)
		throw new Error("Expected one log-format question");
	const question = call.args.questions[0];
	if (
		!question ||
		!/format/i.test(`${question.header} ${question.question}`) ||
		!/plain[- ]?(?:text)?/i.test(JSON.stringify(question.options)) ||
		!/json/i.test(JSON.stringify(question.options))
	)
		throw new Error("The questionnaire did not offer the unresolved log-format choice");
	return {
		cancelled: false,
		answers: [
			{
				questionIndex: 0,
				question: question.question,
				kind: question.multiSelect ? "multi" : "custom",
				...(question.multiSelect ? { selected: [] } : {}),
				answer: RESUME_FORMAT_ANSWER,
			},
		],
	};
}

export function resumeChecks() {
	return [
		checks.expectNoSkillRead(["choosing-a-workflow"]),
		checks.custom("one log-format round retains the exact user answer", ({ log }) => {
			const calls = log.toolCalls("ask_user_question");
			if (calls.length !== 1) return false;
			const call = calls[0];
			if (!call || call.isError || !call.result || typeof call.result !== "object") return false;
			try {
				return (
					"details" in call.result &&
					isDeepStrictEqual(call.result.details, answerResumeQuestion(call))
				);
			} catch {
				return false;
			}
		}),
		checks.expectFile(RESUME_TASK_PATH, (content) => {
			const parsed = parseFile(content);
			const decisions = parsed.body
				.split(/^## /m)
				.find((section) => /^(?:Decisions|Design)\b/.test(section));
			return (
				parsed.frontmatter !== null &&
				scalar(parsed.frontmatter, "id") === "task-verbose-logging" &&
				scalar(parsed.frontmatter, "type") === "task-spec" &&
				/\blog format(?:\*\*)?:\s*(?:\*\*)?plain[- ]text\b/i.test(decisions ?? "") &&
				!/Log format: plain text lines or JSON objects\?/i.test(parsed.body)
			);
		}),
	];
}

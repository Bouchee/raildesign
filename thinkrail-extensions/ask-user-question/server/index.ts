import { tool } from "@openai/agents";
import { createAskUserQuestionSchema, isAskUserQuestionResult } from "@thinkrail/ask-user-question";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	buildQuestionnaireResponse,
	isAskUserQuestionArgs,
	outcomeResult,
	previewFileSources,
	validateQuestionnaire,
} from "@thinkrail/ask-user-question/core";
import { defineServerExtension, type SdkToolServices } from "@thinkrail/extension-api/server";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { thinkrailGuidance } from "./guidance";

function describeResponse(args: unknown, response: unknown): string | undefined {
	if (!isAskUserQuestionArgs(args) || !isAskUserQuestionResult(response)) return undefined;
	return buildQuestionnaireResponse(response, args)
		.content.map((block) => block.text)
		.join("");
}

const resultSchema = Type.Object({
	cancelled: Type.Boolean(),
	answers: Type.Array(
		Type.Object({
			questionIndex: Type.Integer({ minimum: 0 }),
			question: Type.String(),
			kind: Type.Union([
				Type.Literal("option"),
				Type.Literal("custom"),
				Type.Literal("multi"),
				Type.Literal("discuss"),
			]),
			answer: Type.Union([Type.String(), Type.Null()]),
			selected: Type.Optional(Type.Array(Type.String())),
			notes: Type.Optional(Type.String()),
			preview: Type.Optional(Type.String()),
			previewFile: Type.Optional(Type.String()),
			previewBefore: Type.Optional(Type.String()),
			reason: Type.Optional(
				Type.Union([Type.Literal("unclear"), Type.Literal("irrelevant"), Type.Literal("context")]),
			),
		}),
	),
});
function validateArgs(args: unknown): void {
	if (
		!Value.Check(createAskUserQuestionSchema({ filePreviews: true }), args) ||
		!isAskUserQuestionArgs(args)
	)
		throw new Error("Malformed question arguments");
	const valid = validateQuestionnaire(args, { filePreviews: true });
	if (!valid.ok) throw new Error(valid.message);
}
function parseResponse(args: unknown, response: unknown): unknown {
	validateArgs(args);
	if (
		!isAskUserQuestionArgs(args) ||
		!Value.Check(resultSchema, response) ||
		!isAskUserQuestionResult(response)
	)
		throw new Error("Malformed question response");
	const seen = new Set<number>();
	for (const answer of response.answers) {
		const question = args.questions[answer.questionIndex];
		if (!question || question.question !== answer.question || seen.has(answer.questionIndex))
			throw new Error("Question answer does not match its original question");
		seen.add(answer.questionIndex);
		if (
			answer.kind === "option" &&
			!question.options.some((option) => option.label === answer.answer)
		)
			throw new Error("Unknown question option");
		if (
			answer.kind === "multi" &&
			(!question.multiSelect ||
				new Set(answer.selected ?? []).size !== (answer.selected ?? []).length ||
				answer.selected?.some(
					(label) => !question.options.some((option) => option.label === label),
				))
		)
			throw new Error("Invalid multiple-choice answer");
	}
	return response;
}

async function validatedSdkArgs(session: SdkToolServices, args: unknown) {
	session.assertActive();
	validateArgs(args);
	if (!isAskUserQuestionArgs(args)) throw new Error("Malformed question arguments");
	const valid = validateQuestionnaire(args, { filePreviews: session.setting("richPreviews") });
	if (!valid.ok) throw new Error(valid.message);
	for (const source of previewFileSources(args))
		await session.workspaceFiles.check(source.path, session.cwd);
	session.assertActive();
	return args;
}

export default defineServerExtension({
	name: "ask-user-question",
	title: "Ask user question",
	description:
		"Lets the agent pause and ask you structured multiple-choice questions in chat instead of guessing.",
	settings: { richPreviews: { type: "boolean", default: true } },
	interactiveTools: {
		[ASK_USER_QUESTION_TOOL_NAME]: { describeResponse, validateArgs, parseResponse },
	},
	sdkTools: (session) => [
		tool({
			name: ASK_USER_QUESTION_TOOL_NAME,
			description: thinkrailGuidance(
				session.setting("richPreviews"),
				session.workspaceFiles.scratchDir,
			),
			strict: false,
			parameters: {
				...createAskUserQuestionSchema({ filePreviews: session.setting("richPreviews") }),
				additionalProperties: true,
			},
			needsApproval: async (_context, args) => {
				await validatedSdkArgs(session, args);
				return true;
			},
			errorFunction: null,
			async execute(rawArgs, _context, details) {
				const args = await validatedSdkArgs(session, rawArgs);
				if (!details?.toolCall) throw new Error("Question has no call identity");
				const response = session.toolResponse(details.toolCall.callId);
				if (response.kind !== "response") return outcomeResult(response, args);
				const parsed = parseResponse(args, response.value);
				if (!isAskUserQuestionResult(parsed)) throw new Error("Malformed question response");
				return buildQuestionnaireResponse(parsed, args);
			},
		}),
	],
});

import { tool } from "@openai/agents";
import {
	defineServerExtension,
	type ExtensionSessionServices,
	type SdkToolServices,
} from "@thinkrail/extension-api/server";
import {
	type AskUserQuestionAsker,
	createAskUserQuestionExtension,
	createAskUserQuestionSchema,
	isAskUserQuestionResult,
} from "@thinkrail/pi-ask-user-question";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	buildQuestionnaireResponse,
	isAskUserQuestionArgs,
	outcomeResult,
	previewFileSources,
	validateQuestionnaire,
} from "@thinkrail/pi-ask-user-question/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { thinkrailGuidance } from "./guidance";

function askThroughHost(session: ExtensionSessionServices): AskUserQuestionAsker {
	return async ({ toolCallId, signal }) => {
		const response = await session.awaitToolResponse(toolCallId, signal);
		if (response.kind !== "response") return response;
		if (!isAskUserQuestionResult(response.value))
			throw new Error("Malformed ask_user_question response");
		return { kind: "answered", result: response.value };
	};
}

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
	extensions: [],
	settings: { richPreviews: { type: "boolean", default: true } },
	sessionExtensions: (session) => [
		(pi) => {
			const filePreviews = session.setting("richPreviews");
			return createAskUserQuestionExtension({
				ask: askThroughHost(session),
				announce: (toolCallId) => session.expectToolResponse(toolCallId),
				guidance: thinkrailGuidance(filePreviews, session.workspaceFiles.scratchDir),
				filePreviews,
				checkFile: session.workspaceFiles.check,
			})(pi);
		},
	],
	interactiveTools: {
		[ASK_USER_QUESTION_TOOL_NAME]: { describeResponse, validateArgs, parseResponse },
	},
	sdkTools: (session) => [
		tool({
			name: ASK_USER_QUESTION_TOOL_NAME,
			description:
				"Ask structured multiple-choice questions when a concrete decision is required. Execution pauses until the user answers. Use this as the only tool call in its response. Never assume an answer while waiting.",
			strict: false,
			parameters: {
				...createAskUserQuestionSchema({ filePreviews: session.setting("richPreviews") }),
				additionalProperties: true,
			},
			needsApproval: async (_context, args) => {
				await validatedSdkArgs(session, args);
				return true;
			},
			errorFunction: (_context, error, details) => {
				if (details?.toolCall) session.markToolFailed(details.toolCall.callId);
				return JSON.stringify({
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				});
			},
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

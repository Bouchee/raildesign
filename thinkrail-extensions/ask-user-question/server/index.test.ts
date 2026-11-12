import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import {
	ASK_ACK_TEXT,
	ASK_STOPPED_ERROR,
	ASK_USER_QUESTION_TOOL_NAME,
	buildQuestionnaireResponse,
} from "@thinkrail/ask-user-question/core";
import type { SdkToolServices, ToolResponse } from "@thinkrail/extension-api/server";
import askUserQuestion from "./index";

const args = {
	questions: [
		{
			question: "Which library?",
			header: "Lib",
			options: [
				{ label: "date-fns", description: "small" },
				{ label: "luxon", description: "rich" },
			],
		},
	],
};
const answer = {
	cancelled: false,
	answers: [
		{ questionIndex: 0, question: "Which library?", kind: "option" as const, answer: "luxon" },
	],
};
const text = (result: { content: { text: string }[] }) =>
	result.content.map((block) => block.text).join("");

function compose(
	response: ToolResponse = { kind: "deferred" },
	richPreviews = true,
	check: (path: string, cwd: string) => Promise<void> = async () => {},
	assertActive: () => void = () => {},
) {
	const calls: string[] = [];
	const failures: string[] = [];
	const services: SdkToolServices = {
		webAccess: {
			search: async () => {
				throw new Error("No web service in this fixture");
			},
			fetch: async () => {
				throw new Error("No web service in this fixture");
			},
		},
		cwd: "/workspace",
		assertActive,
		toolResponse(callId) {
			calls.push(callId);
			return response;
		},
		markToolFailed(callId) {
			failures.push(callId);
		},
		setting: () => richPreviews,
		workspaceFiles: { check, scratchDir: ".raildesign/context/mockups/" },
	};
	const tool = askUserQuestion.sdkTools(services)[0];
	if (!tool) throw new Error("Missing question tool");
	return {
		tool,
		calls,
		failures,
		async execute(input: unknown = args, callId = "tc") {
			const output = await tool.invoke(new RunContext({}), JSON.stringify(input), {
				toolCall: {
					type: "function_call",
					callId,
					name: ASK_USER_QUESTION_TOOL_NAME,
					arguments: JSON.stringify(input),
				},
			});
			const result = typeof output === "string" ? JSON.parse(output) : output;
			if (result.isError) throw new Error(result.error);
			return result;
		},
	};
}

describe("the SDK question tool", () => {
	test("keeps the interactive contract and complete host guidance", () => {
		const { tool } = compose();
		expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME);
		expect(tool.description).toContain(
			"render as an interactive card docked above the chat's message box",
		);
		expect(tool.description).toContain("then the card is superseded");
		expect(askUserQuestion.settings).toEqual({ richPreviews: { type: "boolean", default: true } });
		expect(Object.keys(askUserQuestion.interactiveTools)).toEqual([ASK_USER_QUESTION_TOOL_NAME]);
		expect(askUserQuestion).not.toHaveProperty("sessionExtensions");
	});

	test("requires approval before it consumes a saved owned response", async () => {
		const fixture = compose({ kind: "response", value: answer });
		expect(await fixture.tool.needsApproval(new RunContext({}), args, "tc")).toBe(true);
		expect(fixture.calls).toEqual([]);
		expect(await fixture.execute()).toEqual(buildQuestionnaireResponse(answer, args));
		expect(fixture.calls).toEqual(["tc"]);
	});

	test("keeps the pending marker and abandonment results", async () => {
		const deferred = await compose().execute();
		expect(text(deferred)).toBe(ASK_ACK_TEXT);
		expect(deferred.details).toEqual({ kind: "ack" });
		expect(deferred.terminate).toBe(true);
		const abandoned = await compose({ kind: "abandoned" }).execute();
		expect(text(abandoned)).toBe(ASK_STOPPED_ERROR);
		expect(abandoned.terminate).toBe(true);
	});

	test("rejects invalid response identities and option selections", async () => {
		for (const value of [
			{ kind: "ack" },
			{ ...answer, answers: [{ ...answer.answers[0], question: "Another question" }] },
			{ ...answer, answers: [{ ...answer.answers[0], answer: "unknown" }] },
			{ ...answer, answers: [answer.answers[0], answer.answers[0]] },
		]) {
			const fixture = compose({ kind: "response", value });
			await expect(fixture.execute()).rejects.toThrow();
			expect(fixture.failures).toEqual(["tc"]);
		}
	});

	test("describes saved and live discussion answers with the same text", () => {
		const policy = askUserQuestion.interactiveTools[ASK_USER_QUESTION_TOOL_NAME];
		const response = {
			cancelled: false,
			answers: [
				{
					questionIndex: 0,
					question: "Which library?",
					kind: "discuss" as const,
					answer: null,
					reason: "unclear" as const,
					notes: "What is luxon?",
				},
			],
		};
		expect(policy.describeResponse(args, response)).toBe(
			text(buildQuestionnaireResponse(response, args)),
		);
		expect(policy.describeResponse(args, response)).toContain(
			"the user wants to discuss this question first",
		);
		expect(policy.describeResponse({ question: "foreign" }, answer)).toBeUndefined();
		expect(policy.describeResponse(args, { picked: "luxon" })).toBeUndefined();
	});

	test("changes offered preview fields and guidance through the setting", () => {
		const optionFields = (tool: ReturnType<typeof compose>["tool"]) =>
			Object.keys(
				(
					tool.parameters.properties.questions as {
						items: { properties: { options: { items: { properties: Record<string, unknown> } } } };
					}
				).items.properties.options.items.properties,
			);
		const rich = compose().tool;
		expect(optionFields(rich)).toContain("previewFile");
		expect(rich.description).toContain("`.raildesign/context/mockups/`");
		const plain = compose({ kind: "deferred" }, false).tool;
		expect(optionFields(plain)).not.toContain("previewFile");
		expect(plain.description).not.toContain("previewFile");
		expect(plain.description).toContain("Discuss button");
	});

	test("checks preview files before approval and again before response execution", async () => {
		const checked: string[] = [];
		const fixture = compose({ kind: "response", value: answer }, true, async (path, cwd) => {
			checked.push(`${cwd}:${path}`);
		});
		const input = { questions: [{ ...args.questions[0], previewFile: "mockups/a.html" }] };
		expect(await fixture.tool.needsApproval(new RunContext({}), input, "tc")).toBe(true);
		expect(fixture.calls).toEqual([]);
		await fixture.execute(input);
		expect(checked).toEqual(["/workspace:mockups/a.html", "/workspace:mockups/a.html"]);
	});

	test("a file-check failure or revoked run cannot consume the response", async () => {
		const failedFile = compose({ kind: "response", value: answer }, true, async () => {
			throw new Error("no such file");
		});
		await expect(
			failedFile.execute({ questions: [{ ...args.questions[0], previewFile: "missing.html" }] }),
		).rejects.toThrow("no such file");
		expect(failedFile.calls).toEqual([]);
		const revoked = compose(
			{ kind: "response", value: answer },
			true,
			async () => {},
			() => {
				throw new Error("Run revoked");
			},
		);
		await expect(revoked.execute()).rejects.toThrow("Run revoked");
		expect(revoked.calls).toEqual([]);
	});
});

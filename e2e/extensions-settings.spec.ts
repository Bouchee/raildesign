import { realpathSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type {
	AskUserQuestionArgs,
	AskUserQuestionResult,
} from "@thinkrail/pi-ask-user-question/core";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

const BASE_TS = 1_700_930_000_000;

async function disableExtension(page: Page, name: string): Promise<void> {
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("settings.update", { config: { disabledExtensions: [name] } });
	} finally {
		wire.close();
	}
}

test.afterEach(async ({ page }) => {
	if (page.isClosed()) return;
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("settings.update", { config: { disabledExtensions: [] } });
	} finally {
		wire.close();
	}
});

test("a historical questionnaire still renders its answers while the extension is off", async ({
	page,
}) => {
	await openFixtureProject(page);
	await disableExtension(page, "ask-user-question");
	const args = {
		questions: [
			{
				question: "Which runtime?",
				header: "Runtime",
				options: [
					{ label: "Bun", description: "fast" },
					{ label: "Node", description: "compatible" },
				],
			},
		],
	} satisfies AskUserQuestionArgs;
	const result: AskUserQuestionResult = {
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Which runtime?", kind: "option", answer: "Bun" }],
	};
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "historical questionnaire",
		messages: [
			{ role: "user", text: "Ask me.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "ask-old", name: "ask_user_question", arguments: args }],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1_000,
			},
			{
				role: "toolResult",
				toolCallId: "ask-old",
				toolName: "ask_user_question",
				content: [
					{ type: "text", text: 'User has answered your questions: "Which runtime?"="Bun".' },
				],
				details: result,
				isError: false,
				timestamp: BASE_TS + 2_000,
			},
		],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, "historical questionnaire");
	const card = page.locator('[data-testid="ask-user-question"][data-tone="answered"]');
	await expect(card).toBeVisible();
	await expect(card).toContainText("Which runtime?");
	await expect(card).toContainText("Bun");
});

test("a historical visualize call still renders its diagram while the extension is off", async ({
	page,
}) => {
	await openFixtureProject(page);
	await disableExtension(page, "visualize");
	const args = {
		type: "diagram",
		title: "Historical path",
		mermaid: "flowchart LR; Before --> After",
	};
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "historical visualize",
		messages: [
			{ role: "user", text: "Draw it.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "visualize-old", name: "visualize", arguments: args }],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1_000,
			},
			{
				role: "toolResult",
				toolCallId: "visualize-old",
				toolName: "visualize",
				content: [{ type: "text", text: "Visualization complete." }],
				details: args,
				isError: false,
				timestamp: BASE_TS + 2_000,
			},
		],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, "historical visualize");
	const card = page.locator('[data-testid="tool-card"][data-tool="visualize"]');
	await expect(card).toHaveCount(1);
	const diagram = card.getByTestId("tool-visualize-diagram");
	await expect(diagram).toBeVisible();
	await expect(diagram.getByTestId("mermaid-svg").locator("svg")).toBeVisible({
		timeout: 20_000,
	});
});

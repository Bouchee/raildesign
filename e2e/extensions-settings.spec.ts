import { realpathSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { AskUserQuestionArgs, AskUserQuestionResult } from "@thinkrail/ask-user-question/core";
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

test("SDK extension switches persist without Pi installation controls or requests", async ({
	page,
}) => {
	const methods: string[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string") return;
			try {
				const request = JSON.parse(payload) as { method?: string };
				if (request.method) methods.push(request.method);
			} catch {}
		});
	});
	await openFixtureProject(page);
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-extensions").click();
	const settings = page.getByTestId("settings-extensions");
	const toggle = settings.getByTestId("extension-toggle-visualize");
	await expect(toggle).toHaveRole("switch");
	await expect(toggle).toHaveAttribute("aria-checked", /true|false/);
	await expect(settings.getByTestId("settings-bundled-extensions")).toBeVisible();
	await expect(settings.getByTestId("web-access-key")).toBeVisible();
	await expect(settings.getByTestId("other-agent-skills-toggle")).toBeVisible();
	for (const testId of ["packages-install", "settings-packages", "settings-builtins"]) {
		await expect(settings.getByTestId(testId)).toHaveCount(0);
	}
	const before = await toggle.getAttribute("aria-checked");
	const after = before === "true" ? "false" : "true";
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", after);
	const catalogReads = methods.filter((method) => method === "extension.list").length;
	expect(catalogReads).toBeGreaterThan(0);
	expect(methods.filter((method) => method.startsWith("packages."))).toEqual([]);

	await page.reload();
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-extensions").click();
	await expect(toggle).toHaveAttribute("aria-checked", after);
	await expect(settings.getByTestId("web-access-key")).toBeVisible();
	await expect
		.poll(() => methods.filter((method) => method === "extension.list").length)
		.toBeGreaterThan(catalogReads);
	expect(methods.filter((method) => method.startsWith("packages."))).toEqual([]);
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

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ToolResponsePendingDetails } from "@thinkrail/contracts";
import type { AskUserQuestionArgs } from "@thinkrail/pi-ask-user-question/core";
import {
	enterDefaultWorkspace,
	hideAuxiliaryWorkbench,
	openFixtureProject,
	openPersistedChat,
	revealWorkbenchTool,
} from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

const BASE_TS = 1_700_800_000_000;

test("a pending ask surfaces on the rail as waiting_question glance, not paused", async ({
	page,
}) => {
	await openFixtureProject(page);
	const askArgs = {
		questions: [
			{
				question: "Is this blocking?",
				header: "Blocking",
				options: [
					{ label: "Yes", description: "stop and ask" },
					{ label: "No", description: "keep going" },
				],
			},
		],
	} satisfies AskUserQuestionArgs;
	const ack: ToolResponsePendingDetails = { kind: "ack" };
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "rail glance on pending ask",
		state: {
			execution: "idle",
			runId: "ask-rail-run",
			needsInput: {
				interactionId: "ask-rail",
				kind: "tool-response",
				toolCallId: "ask-rail",
				runId: "ask-rail-run",
				revision: 0,
			},
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
		messages: [
			{ role: "user", text: "Ping.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "ask-rail", name: "ask_user_question", arguments: askArgs },
				],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1000,
			},
			{
				role: "toolResult",
				toolCallId: "ask-rail",
				toolName: "ask_user_question",
				content: [{ type: "text", text: "awaiting" }],
				details: ack,
				isError: false,
				timestamp: BASE_TS + 2000,
			},
		],
	});
	try {
		await enterDefaultWorkspace(page);
		await hideAuxiliaryWorkbench(page);
		await openPersistedChat(page, "rail glance on pending ask");
		await revealWorkbenchTool(page, "plan");
		const rail = page.getByTestId("plan-rail-pane");
		await expect(rail).toBeVisible();
		await expect(rail).toHaveAttribute("data-glance", "waiting_question");
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("the plan shows the agent's latest message when it isn't asking or on a step", async ({
	page,
}) => {
	await openFixtureProject(page);
	const repo = realpathSync(E2E_FIXTURE_REPO);
	const session = seedWorkspaceSession(repo, {
		name: "agent activity",
		messages: [
			{ role: "user", text: "Look into the Telegram reminders.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Two problems with Lab Organic reminders: the day_of_visit avalanche and duplicates on resend \u2014 digging into the sender now.",
					},
				],
				stopReason: "stop",
				timestamp: BASE_TS + 1000,
			},
		],
	});
	const todosDir = join(repo, ".raildesign", "context", "todos");
	mkdirSync(todosDir, { recursive: true });
	const todosPath = join(todosDir, `${session.id}.json`);
	writeFileSync(
		todosPath,
		JSON.stringify({
			version: 6,
			todos: [
				{
					id: "p1",
					title: "Dedup reminders by visit_id",
					status: "pending",
					origin: "agent",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
			groups: [],
		}),
	);
	try {
		await enterDefaultWorkspace(page);
		await hideAuxiliaryWorkbench(page);
		await openPersistedChat(page, "agent activity");
		await revealWorkbenchTool(page, "plan");
		await page.getByTestId("plan-rail-pane").getByTestId("todo-open-plan").click();
		const pane = page.getByTestId("plan-pane");
		await expect(pane).toBeVisible();
		await expect(pane.getByTestId("plan-agent-message")).toContainText("day_of_visit avalanche");
	} finally {
		rmSync(todosPath, { force: true });
		rmSync(session.path, { force: true });
	}
});

test("a pending question's file preview renders on the plan page and opens in a tab", async ({
	page,
}) => {
	await openFixtureProject(page);
	const repo = realpathSync(E2E_FIXTURE_REPO);
	const mockups = join(repo, ".raildesign", "context", "mockups");
	mkdirSync(mockups, { recursive: true });
	writeFileSync(
		join(mockups, "plan-today.html"),
		"<!doctype html><html><body><h1>Today</h1></body></html>",
	);
	const args = {
		questions: [
			{
				question: "Does the plan page look right?",
				header: "Plan page",
				previewFile: ".raildesign/context/mockups/plan-today.html",
				options: [{ label: "Looks right", description: "accurate as written" }],
			},
		],
	} satisfies AskUserQuestionArgs;
	const ack: ToolResponsePendingDetails = { kind: "ack" };
	const session = seedWorkspaceSession(repo, {
		name: "plan ask preview",
		state: {
			execution: "idle",
			runId: "ask-plan-preview-run",
			needsInput: {
				interactionId: "ask-plan-preview",
				kind: "tool-response",
				toolCallId: "ask-plan-preview",
				runId: "ask-plan-preview-run",
				revision: 0,
			},
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
		messages: [
			{ role: "user", text: "Ask me.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "ask-plan-preview", name: "ask_user_question", arguments: args },
				],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1000,
			},
			{
				role: "toolResult",
				toolCallId: "ask-plan-preview",
				toolName: "ask_user_question",
				content: [{ type: "text", text: "awaiting" }],
				details: ack,
				isError: false,
				timestamp: BASE_TS + 2000,
			},
		],
	});
	try {
		await enterDefaultWorkspace(page);
		await hideAuxiliaryWorkbench(page);
		await openPersistedChat(page, "plan ask preview");
		await revealWorkbenchTool(page, "plan");
		await page.getByTestId("plan-rail-pane").getByTestId("todo-open-plan").click();
		const card = page.getByTestId("plan-pane").getByTestId("plan-ask");
		const subject = card.getByTestId("ask-question-preview");
		await expect(subject.getByTestId("html-frame-box")).toBeVisible();
		await subject.getByTestId("ask-preview-open-tab").click();
		await expect(
			page
				.locator('[data-testid="editor-tab"][data-kind="file"]')
				.filter({ hasText: "plan-today.html" }),
		).toBeVisible();
	} finally {
		rmSync(session.path, { force: true });
		rmSync(join(repo, ".raildesign", "context", "mockups"), { recursive: true, force: true });
	}
});

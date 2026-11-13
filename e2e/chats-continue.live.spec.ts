import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Workspace } from "@thinkrail/contracts";
import {
	loadPersistedWorkspaces,
	openFixtureProject,
	waitForAgentSettled,
	worktreeRows,
} from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

function storedChats(): { chats: Workspace[] } {
	return JSON.parse(readFileSync(join(E2E_DATA_DIR, "chats.json"), "utf8"));
}

test(
	"Continue in workspace uses the SDK summary, creates the handoff and restores the persisted link",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		await openFixtureProject(page);
		await expect(worktreeRows(page)).toHaveCount(0);
		await page.getByTestId("add-chat").click();
		await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "chat");

		await page
			.getByTestId("chat-input")
			.fill(
				"This is a chat-only handoff probe. Do not call tools or inspect files. Remember our decision: add a one-line project description at the top of README.md. After we continue in a workspace, only acknowledge this brief without calling tools. For now, reply exactly HANDOFF_BRIEF_NOTED.",
			);
		await page.getByTestId("chat-send").click();
		await waitForAgentSettled(page, 90_000);

		const row = page.getByTestId("chat-item");
		await row.getByTestId("chat-menu").click();
		await page.getByTestId("chat-continue").click();
		const dialog = page.getByTestId("continue-chat-dialog");
		await dialog.getByTestId("continue-chat-confirm").click();
		await expect(dialog).toBeHidden();

		const card = page.getByTestId("continuation-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toHaveAttribute("data-phase", /summarizing|creating|started/);

		await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "workspace", {
			timeout: 150_000,
		});
		await expect(worktreeRows(page)).toHaveCount(1);
		const handoff = page.getByTestId("handoff-card");
		await expect(handoff).toBeVisible({ timeout: 30_000 });
		await expect(handoff).toContainText("Continued from");
		await expect(handoff.getByTestId("handoff-summary")).not.toBeEmpty();
		await expect(handoff.getByTestId("handoff-summary")).toContainText("README.md");

		const [chat] = storedChats().chats;
		const created = loadPersistedWorkspaces().find((candidate) => candidate.kind !== "default");
		expect(chat?.continuedTo?.[0]?.workspaceId).toBe(created?.id);
		await expect(page.getByTestId("chat-continued")).toContainText("Continued in sample-project");

		await handoff.getByTestId("handoff-open-source").click();
		await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "chat");
		await expect(card).toHaveAttribute("data-phase", "started", { timeout: 30_000 });
		await expect(card.getByTestId("continuation-status")).toContainText(
			"Continued in a new workspace",
		);
		await expect(card.getByTestId("continuation-open")).toBeVisible();
		const operationId = chat?.continuedTo?.[0]?.operationId;
		if (!operationId) throw new Error("The continuation did not persist its operation ID");
		await page.reload();
		await expect(page.getByTestId("continuation-card")).toHaveAttribute("data-phase", "started");
		await expect(page.getByTestId("chat-continued")).toContainText("Continued in sample-project");
		const wire = await E2eWire.connect();
		try {
			const status = await wire.request("chat.continuationStatus", { operationId });
			expect(status).toMatchObject({
				phase: "started",
				workspaceId: created?.id,
			});
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: status.sourceWorkspaceId,
				sessionId: status.sourceSessionId,
			});
			expect(
				snapshot.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "continue_in_workspace" &&
						!message.isError,
				),
			).toBe(true);
			await testInfo.attach("sdk-continuation", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ status, chat, created, snapshot })),
			});
		} finally {
			wire.close();
		}
	},
);

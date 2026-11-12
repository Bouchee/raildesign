import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, waitForAgentSettled } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test(
	"manual summary retains the transcript and facts through continuation and reload",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		await openFixtureProject(page);
		const workspace = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("The summary test chat has no session ID");
			const input = page.getByTestId("chat-input");
			const oldInput = [
				"Remember these three facts: checkpoint word riverstone; vessel alloy titanium; project code LANTERN42.",
				"The following numbered lines are disposable padding. Keep the three facts. Do not use tools. Reply only READY.",
				...Array.from(
					{ length: 80 },
					(_, i) => `Padding ${i}: this line has no project information and can be discarded.`,
				),
			].join("\n");
			await input.fill(oldInput);
			await page.getByTestId("chat-send").click();
			await waitForAgentSettled(page);
			await input.fill(
				"Remember the recent inspection date: 2030-06-18. Do not use tools. Reply only RECENT.",
			);
			await page.getByTestId("chat-send").click();
			await expect(
				page.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
			).toContainText("RECENT", { timeout: 60_000 });
			await waitForAgentSettled(page);
			const before = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});

			await input.fill(
				"/compact Keep checkpoint word, vessel alloy, project code and inspection date exactly. Discard numbered padding.",
			);
			await page.getByTestId("chat-send").click();
			const marker = page.getByTestId("chat-compaction");
			await expect(marker).toBeVisible({ timeout: 90_000 });
			const compacted = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			for (const message of before.messages)
				expect(compacted.messages.find((candidate) => candidate.id === message.id)).toEqual(
					message,
				);
			const summary = compacted.messages.find((message) => message.role === "compactionSummary");
			if (summary?.role !== "compactionSummary") throw new Error("No saved summary receipt");
			expect(summary.summary).toContain("riverstone");
			expect(summary.summary.toLowerCase()).toContain("titanium");
			expect(summary.summary).toContain("LANTERN42");

			await input.fill(
				"Recall the checkpoint word, vessel alloy, project code and recent inspection date. Give all four values, without tools.",
			);
			await page.getByTestId("chat-send").click();
			const reply = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
			await expect(reply).toContainText("riverstone", { timeout: 90_000 });
			await expect(reply).toContainText(/titanium/i);
			await expect(reply).toContainText("LANTERN42");
			await expect(reply).toContainText("2030-06-18");
			await waitForAgentSettled(page);
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveAttribute(
				"data-session-id",
				sessionId,
			);
			await expect(marker).toBeVisible();
			await expect(reply).toContainText("LANTERN42");
			await testInfo.attach("summary-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{
							sessionId,
							summary,
							beforeMessageIds: before.messages.map((message) => message.id),
							afterMessageIds: compacted.messages.map((message) => message.id),
						},
						null,
						2,
					),
				),
			});
		} finally {
			wire.close();
		}
	},
);

import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { defaultWorkspaceRow, enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

const BASE_TS = 1_700_300_000_000;

const repoCwd = () => realpathSync(E2E_FIXTURE_REPO);

test("a compacted transcript marks where the summarized messages were", async ({ page }) => {
	await openFixtureProject(page);

	seedWorkspaceSession(repoCwd(), {
		name: "the long chat",
		messages: [
			{
				role: "compactionSummary",
				summary: "## Earlier work\nRenamed the widget factory.",
				tokensBefore: 148_000,
				timestamp: BASE_TS + 1_000,
			},
			{ role: "user", text: "kept question", timestamp: BASE_TS + 2_000 },
			{ role: "assistant", text: "kept answer", timestamp: BASE_TS + 3_000 },
		],
	});

	await expect(defaultWorkspaceRow(page)).toBeVisible();
	await enterDefaultWorkspace(page);
	await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(1);

	await expect(page.getByText("kept question")).toBeVisible();
	await expect(page.getByText("summarized question")).toHaveCount(0);

	const marker = page.getByTestId("chat-compaction");
	await expect(marker).toContainText("Context compacted");
	await expect(marker).toContainText("148k tokens");
	await expect(page.getByText("Renamed the widget factory.")).toHaveCount(0);
	await marker.getByRole("button").click();
	await expect(page.getByText("Renamed the widget factory.")).toBeVisible();
});

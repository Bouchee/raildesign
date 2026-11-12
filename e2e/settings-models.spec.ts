import { expect, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";

test("model settings expose the accepted default without unavailable agent controls", async ({
	page,
}) => {
	await openWorkspaceChat(page);
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-models").click();
	await expect(page.getByTestId("settings-models")).toBeVisible();
	await expect(page.getByTestId("default-model-row")).toContainText("deepseek-v4.1-flash");
	await expect(page.getByTestId("models-review-group")).toHaveCount(0);
	await expect(page.getByTestId("settings-cache-warming")).toHaveCount(0);
});

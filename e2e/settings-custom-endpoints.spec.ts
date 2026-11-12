import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { openProviders } from "./fixtures/providers";

test("the SDK endpoint form saves and removes an accepted model without invoking it", async ({
	page,
}) => {
	await openWorkspaceChat(page);
	await openProviders(page);
	const group = page.getByTestId("settings-custom-endpoints");
	await group.getByTestId("custom-endpoints-add").click();
	const dialog = page.getByTestId("custom-endpoints-dialog");
	await dialog.getByTestId("custom-endpoints-name").fill("SDK endpoint from UI");
	await dialog
		.getByTestId("custom-endpoints-url")
		.fill("https://opencode.ai/inference/go/openai/v1");
	await dialog.getByTestId("custom-endpoints-manual").fill("deepseek-v4.1-flash");
	await dialog.getByTestId("custom-endpoints-manual-add").click();
	await dialog.getByTestId("custom-endpoints-save").click();
	await expect(dialog).toHaveCount(0);
	const row = group
		.getByTestId("custom-endpoints-endpoint")
		.filter({ hasText: "SDK endpoint from UI" });
	await expect(row).toBeVisible();
	const record = JSON.parse(readFileSync(join(E2E_DATA_DIR, "models.json"), "utf8"));
	expect(record.version).toBe(1);
	expect(record.endpoints).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "SDK endpoint from UI" })]),
	);
	await row.getByTestId("custom-endpoints-remove").click();
	await page.getByTestId("custom-endpoints-remove-confirm").click();
	await expect(row).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { openWorkspaceChat, revealModelGroups } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("the composer lists the accepted SDK model and keeps unavailable pricing and context hidden", async ({
	page,
}) => {
	const workspace = await openWorkspaceChat(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const models = await wire.request("model.list", {});
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "deepseek-v4.1-flash",
			contextWindow: 0,
			thinkingLevels: ["off"],
		});
		expect(models[0]?.cost).toBeUndefined();
		await page.getByTestId("model-selector").last().click();
		await revealModelGroups(page);
		const option = page
			.locator('[data-testid="model-option"][data-model-id="deepseek-v4.1-flash"]')
			.first();
		await expect(option).toBeVisible();
		await expect(option).not.toContainText("$0");
		await option.click();
		await page.keyboard.press("Escape");
		expect(await wire.request("session.list", { workspaceId: workspace.id })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					model: expect.objectContaining({ id: "deepseek-v4.1-flash" }),
					thinkingLevel: "off",
				}),
			]),
		);
	} finally {
		wire.close();
	}
});

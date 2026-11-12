import { expect, type Locator, type Page } from "@playwright/test";

export async function openProviders(page: Page): Promise<Locator> {
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-providers").click();
	await expect(page.getByTestId("settings-providers")).toBeVisible();
	return page.getByTestId("settings-providers");
}

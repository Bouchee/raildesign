import { expect, test } from "@playwright/test";
import { resetApp } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("first-run setup opens the SDK endpoint form without telemetry or upstream account steps", async ({
	page,
	baseURL,
}) => {
	await resetApp(page);
	if (!baseURL) throw new Error("The isolated host URL is required");
	const wire = await E2eWire.connect(Number(new URL(baseURL).port));
	try {
		await wire.request("settings.update", { config: { onboardingDismissed: false } });
		await page.goto("/");
		await expect(page.getByTestId("onboarding-wizard")).toHaveAttribute("data-step", "intro");
		await expect(page.getByTestId("onboarding-intro")).toContainText("RailDesign");
		await page.getByTestId("onboarding-start").click();
		await expect(page.getByTestId("connect-provider-options")).toBeVisible();
		await expect(page.getByTestId("custom-endpoints-add")).toBeVisible();
		await expect(page.getByTestId("onboarding-privacy")).toHaveCount(0);
		await expect(page.getByTestId("jetbrains-ai-card")).toHaveCount(0);
		await page.getByTestId("onboarding-skip").click();
		await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
	} finally {
		await wire.request("settings.update", { config: { onboardingDismissed: true } });
		wire.close();
	}
});

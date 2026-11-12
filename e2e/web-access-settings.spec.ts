import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

test("DeepSeek settings save a private key and restore only its status", async ({ page }) => {
	await openWorkspaceChat(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("webAccess.configure", { apiKey: "" });
		await page.getByTestId("open-settings").click();
		await page.getByTestId("settings-nav-extensions").click();
		const settings = page.getByTestId("settings-web-access");
		await expect(settings.getByTestId("web-access-status")).toHaveText(
			"No DeepSeek platform key is configured.",
		);
		await settings.getByTestId("web-access-key").fill("fixture-deepseek-settings-key");
		await settings.getByTestId("web-access-save").click();
		await expect(settings.getByTestId("web-access-key")).toHaveValue("");
		await expect(settings.getByTestId("web-access-status")).toHaveText(
			"A DeepSeek platform key is configured.",
		);
		expect(await wire.request("webAccess.status", {})).toEqual({ configured: true });
		const file = join(E2E_DATA_DIR, "web-access.json");
		expect(readFileSync(file, "utf8")).toContain("fixture-deepseek-settings-key");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		await page.reload();
		await page.getByTestId("open-settings").click();
		await page.getByTestId("settings-nav-extensions").click();
		await expect(settings.getByTestId("web-access-key")).toHaveValue("");
		await expect(settings.getByTestId("web-access-status")).toHaveText(
			"A DeepSeek platform key is configured.",
		);
		await settings.getByTestId("web-access-clear").click();
		await expect(settings.getByTestId("web-access-status")).toHaveText(
			"No DeepSeek platform key is configured.",
		);
		expect(await wire.request("webAccess.status", {})).toEqual({ configured: false });
	} finally {
		await wire.request("webAccess.configure", { apiKey: "" });
		wire.close();
	}
});

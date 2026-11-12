import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	createWorkspaceViaDialog,
	openAppFresh,
	openFixtureProject,
	stagePlainFolder,
	worktreeRows,
} from "./fixtures/app";
import { git } from "./fixtures/git";
import { E2E_FIXTURE_REPO, E2E_PLAIN_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

const FIXTURE_SPECS = ["SPEC.md", join("module-a", "SPEC.md")];

async function hostReportsConnectedProvider(page: Page): Promise<boolean> {
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const report = await wire.request("provider.status", {});
		return report.providers.some((provider) => provider.configured);
	} finally {
		wire.close();
	}
}

test("opens a clean RailDesign with no projects imported", async ({ page }) => {
	await openAppFresh(page);

	await expect(page.getByTestId("welcome")).toBeVisible();
	await expect(page.getByTestId("center-tabs")).toHaveCount(0);
	await expect(page.getByTestId("right-panel")).toHaveCount(0);
	await expect(page.getByTestId("terminal-panel")).toHaveCount(0);

	await expect(page.getByTestId("welcome-title")).toHaveText("RailDesign");
	await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
	await expect(page.getByTestId("welcome-cta")).toContainText("Start a new project");
	await expect(page.getByTestId("welcome-action")).toHaveCount(2);
	await expect(page.getByTestId("welcome-action").nth(1)).toContainText("Chat without a project");

	await page.getByTestId("welcome-action").filter({ hasText: "Open project" }).click();
	await expect(page.getByTestId("menu-open-project")).toBeVisible();
});

test("the Welcome provider action opens the shared SDK endpoint form", async ({ page }) => {
	await openAppFresh(page);
	if (!(await hostReportsConnectedProvider(page))) {
		await page.getByTestId("welcome-connect-provider").click();
		await expect(page.getByTestId("connect-provider-dialog")).toBeVisible();
		await expect(page.getByTestId("custom-endpoints-add")).toBeVisible();
		await expect(page.getByTestId("jetbrains-ai-card")).toHaveCount(0);
	}
});

test("Settings → Providers opens the SDK endpoint settings", async ({ page }) => {
	await openAppFresh(page);
	await page.getByTestId("open-settings").click();
	await expect(page.getByTestId("settings-providers")).toBeVisible();
	await expect(page.getByTestId("settings-custom-endpoints")).toBeVisible();
});

test("a project with specs offers Start building over Set up, beside the project-folder fork", async ({
	page,
}) => {
	await openFixtureProject(page);
	await expect(page.getByTestId("welcome-title")).toHaveText("sample-project");
	const scope = page.getByTestId("scope-context");
	await expect(scope).toHaveAttribute("data-context", "project-home");
	await expect(scope).toContainText("sample-project");
	await expect(scope).toContainText("Project home");
	await expect(page.getByTestId("welcome-cta")).toContainText("Start building");
	await expect(page.getByTestId("welcome-action")).toHaveCount(1);
	await expect(
		page.getByTestId("welcome-action").filter({ hasText: "Work in project folder" }),
	).toBeVisible();
	await expect(page.getByText("Set up project")).toHaveCount(0);
	await expect(page.getByTestId("welcome").getByText("Open project")).toHaveCount(0);
});

test("a project without specs suggests setting it up", async ({ page }) => {
	for (const spec of FIXTURE_SPECS) rmSync(join(E2E_FIXTURE_REPO, spec), { force: true });
	try {
		await openFixtureProject(page);
		await expect(page.getByTestId("welcome-title")).toHaveText("sample-project");
		await expect(page.getByTestId("welcome-cta")).toContainText("Set up project");
		await expect(page.getByTestId("welcome-action")).toHaveCount(2);
		await expect(
			page.getByTestId("welcome-action").filter({ hasText: "Start building" }),
		).toBeVisible();
		await expect(
			page.getByTestId("welcome-action").filter({ hasText: "Work in project folder" }),
		).toBeVisible();

		await page.getByTestId("welcome-cta").click();
		const dialog = page.getByTestId("new-workspace-dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByTestId("ws-prompt")).toHaveValue("/skill:setting-up-a-project ");
		await expect(dialog.getByTestId("slash-menu")).toHaveCount(0);
		await expect(dialog.getByTestId("ws-target-worktree")).toHaveAttribute("data-active", "true");
		await expect(dialog.getByRole("heading", { name: "Create workspace" })).toBeVisible();
		await expect(dialog.getByTestId("ws-branch-picker")).toBeVisible();
		await expect(dialog.getByTestId("ws-prompt-note")).toContainText("setting-up-a-project skill");

		await dialog.getByTestId("ws-target-default").click();
		await expect(dialog.getByRole("heading", { name: "Work in project folder" })).toBeVisible();
		await expect(dialog).toContainText("no isolation");
		await expect(dialog.getByTestId("ws-branch-picker")).toHaveCount(0);

		await dialog.getByTestId("ws-prompt").fill("");
		await expect(page.getByTestId("create-workspace")).toHaveText(/Start/);
		await page.getByTestId("create-workspace").click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("welcome")).toHaveCount(0);
		await expect(page.getByTestId("center-tabs")).toBeVisible();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(page.getByTestId("terminal-panel")).toBeVisible();
		await expect(
			page.locator('[data-testid="workspace-item"][data-kind="default"]'),
		).toHaveAttribute("data-active", "true");
		await expect(worktreeRows(page)).toHaveCount(0);
	} finally {
		git(E2E_FIXTURE_REPO, "checkout", "--", ...FIXTURE_SPECS);
	}
});

test("opening a non-git folder from the Welcome screen offers to initialise a repo", async ({
	page,
}) => {
	await stagePlainFolder(page);
	await page.goto("/");
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("welcome")).toBeVisible();

	await page.getByTestId("welcome-action").filter({ hasText: "Open project" }).click();
	await page.getByTestId("menu-open-project").click();

	const confirmInit = page.getByTestId("confirm-init-repo");
	await expect(confirmInit).toBeVisible();
	await confirmInit.click();

	await expect(
		page.getByTestId("project-item").filter({ hasText: basename(E2E_PLAIN_DIR) }),
	).toBeVisible();
	await expect(page.getByTestId("welcome")).toBeVisible();
	await expect(page.getByTestId("center-tabs")).toHaveCount(0);
	await expect(page.getByTestId("welcome-title")).toHaveText(basename(E2E_PLAIN_DIR));
	await expect(page.getByTestId("welcome-cta")).toContainText("Set up project");
	await expect(
		page.getByTestId("welcome-action").filter({ hasText: "Work in project folder" }),
	).toBeVisible();
});

test("clicking a project returns to its Welcome, deselecting the active workspace", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await expect(page.getByTestId("center-tabs")).toBeVisible();
	await expect(page.locator('[data-testid="workspace-item"][data-active="true"]')).toHaveCount(1);

	await page.getByTestId("project-item").first().getByText("sample-project").click();
	await expect(page.getByTestId("welcome")).toBeVisible();
	await expect(page.getByTestId("center-tabs")).toHaveCount(0);
	await expect(page.locator('[data-testid="workspace-item"][data-active="true"]')).toHaveCount(0);

	await worktreeRows(page).first().getByRole("button").first().click();
	await expect(page.getByTestId("center-tabs")).toBeVisible();
});

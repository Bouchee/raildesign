import { expect, type Page, test } from "@playwright/test";
import {
	createWorkspaceViaDialog,
	enterDefaultWorkspace,
	openFixtureProject,
	openWorkspaceMenu,
	waitTerminalReady,
	worktreeRows,
} from "./fixtures/app";
import { installChannelHold } from "./fixtures/channelHold";
import { E2eWire } from "./fixtures/wire";

async function openChatSettings(page: Page): Promise<void> {
	if (!(await page.getByTestId("settings-dialog").isVisible())) {
		await page.getByTestId("open-settings").click();
	}
	await page.getByTestId("settings-nav-chat").click();
	await expect(page.getByTestId("settings-subagents")).toBeVisible();
}

function controls(page: Page) {
	return {
		global: page.getByTestId("subagents-global-toggle"),
		workspace: page.getByTestId("subagents-workspace-toggle"),
		source: page.getByTestId("subagents-workspace-source"),
		globalLimit: page.getByTestId("subagent-limit-global-input"),
		workspaceLimit: page.getByTestId("subagent-limit-workspace-input"),
		limitSource: page.getByTestId("subagent-limit-workspace-source"),
	};
}

async function closeSettings(page: Page): Promise<void> {
	const dialog = page.getByTestId("settings-dialog");
	if (!(await dialog.isVisible())) return;
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
}

async function fixtureWorkspace(wire: E2eWire): Promise<string> {
	const [project] = await wire.request("project.list", {});
	if (!project) throw new Error("Missing fixture project");
	const workspace = (await wire.request("workspace.list", { projectId: project.id })).find(
		(item) => item.kind === "default",
	);
	if (!workspace) throw new Error("Missing default workspace");
	return workspace.id;
}

async function restoreSubagentBaseline(page: Page): Promise<void> {
	if (page.isClosed()) return;
	const wire = await E2eWire.connect();
	try {
		const id = await fixtureWorkspace(wire);
		await wire.request("settings.update", {
			config: { subagentsEnabled: true, subagentMaxConcurrent: 4 },
		});
		await wire.request("workspace.setSubagentsOverride", { id, override: null });
		await wire.request("workspace.setSubagentMaxConcurrent", { id, value: null });
	} finally {
		wire.close();
	}
	await closeSettings(page);
	await openChatSettings(page);
}

test("a maximal unbroken workspace name stays contained on a phone-sized settings pane", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await waitTerminalReady(page);
	const row = worktreeRows(page).first();
	const longName = "W".repeat(60);
	await openWorkspaceMenu(row);
	await page.getByTestId("workspace-rename").click();
	const input = row.getByRole("textbox", { name: "Workspace name" });
	await input.fill(longName);
	await input.press("Enter");
	await expect(row.getByTestId("workspace-name")).toHaveText(longName);

	await page.setViewportSize({ width: 390, height: 780 });
	await openChatSettings(page);
	for (const control of Object.values(controls(page))) {
		if ((await control.getAttribute("data-source")) === "global") continue;
		await expect(control).toBeEnabled();
	}
	await expect(page.getByTestId("subagents-global-toggle")).toBeEnabled();
	const heading = page.getByTestId("subagents-workspace-heading");
	await expect(heading).toContainText(longName);
	for (const element of [heading, page.getByTestId("settings-subagents")]) {
		expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	}
});

test("global and workspace subagent switches converge from authoritative pushes", async ({
	page,
	context,
}) => {
	const channelHold = await installChannelHold(page);
	let releaseGlobal = () => {};
	let releaseWorkspace = () => {};
	let peer: Page | undefined;
	const wire = await E2eWire.connect();
	let id = "";
	try {
		await openFixtureProject(page);
		await enterDefaultWorkspace(page);
		await restoreSubagentBaseline(page);
		id = await fixtureWorkspace(wire);

		peer = await context.newPage();
		await peer.goto(page.url());
		await expect(peer.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openChatSettings(page);
		await openChatSettings(peer);
		const source = controls(page);
		const observer = controls(peer);
		await expect(source.global).toHaveAttribute("data-active", "true");
		await expect(source.workspace).toHaveAttribute("data-active", "true");
		await expect(source.source).toHaveAttribute("data-source", "global");

		const globalFrame = channelHold.arm("settings.changed");
		releaseGlobal = globalFrame.release;
		await source.global.click();
		await globalFrame.held;
		await expect(source.global).toHaveAttribute("data-active", "true");
		await expect(observer.global).toHaveAttribute("data-active", "false");
		releaseGlobal();
		await expect(source.global).toHaveAttribute("data-active", "false");
		await expect(source.workspace).toHaveAttribute("data-active", "false");
		await expect(source.source).toHaveAttribute("data-source", "global");

		const workspaceFrame = channelHold.arm("workspace.updated");
		releaseWorkspace = workspaceFrame.release;
		await source.workspace.click();
		await workspaceFrame.held;
		await expect(source.workspace).toHaveAttribute("data-active", "false");
		await expect(observer.workspace).toHaveAttribute("data-active", "true");
		await expect(observer.source).toHaveAttribute("data-source", "custom");
		releaseWorkspace();
		await expect(source.workspace).toHaveAttribute("data-active", "true");
		await expect(source.source).toHaveAttribute("data-source", "custom");

		await wire.request("settings.update", { config: { subagentsEnabled: true } });
		await wire.request("workspace.setSubagentsOverride", { id, override: "off" });
		for (const current of [source, observer]) {
			await expect(current.global).toHaveAttribute("data-active", "true");
			await expect(current.workspace).toHaveAttribute("data-active", "false");
			await expect(current.source).toHaveAttribute("data-source", "custom");
		}

		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openChatSettings(page);
		await expect(source.global).toHaveAttribute("data-active", "true");
		await expect(source.workspace).toHaveAttribute("data-active", "false");

		await wire.request("workspace.setSubagentsOverride", { id, override: null });
		for (const current of [source, observer]) {
			await expect(current.workspace).toHaveAttribute("data-active", "true");
			await expect(current.source).toHaveAttribute("data-source", "global");
		}
	} finally {
		releaseGlobal();
		releaseWorkspace();
		await restoreSubagentBaseline(page).catch(() => {});
		await peer?.close();
		wire.close();
	}
});

test("global and workspace subagent limits persist, inherit, and converge across clients", async ({
	page,
	context,
}) => {
	let peer: Page | undefined;
	const wire = await E2eWire.connect();
	let id = "";
	try {
		await openFixtureProject(page);
		await enterDefaultWorkspace(page);
		await restoreSubagentBaseline(page);
		id = await fixtureWorkspace(wire);
		peer = await context.newPage();
		await peer.goto(page.url());
		await expect(peer.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openChatSettings(page);
		await openChatSettings(peer);
		const source = controls(page);
		const observer = controls(peer);

		await expect(source.globalLimit).toHaveValue("4");
		await expect(source.workspaceLimit).toHaveValue("");
		await expect(source.workspaceLimit).toHaveAttribute("placeholder", "4");
		await expect(source.limitSource).toHaveAttribute("data-source", "global");

		await expect(source.globalLimit).toBeEnabled();
		await expect(source.workspaceLimit).toBeEnabled();
		await expect(
			wire.request("settings.update", { config: { subagentMaxConcurrent: 0 } }),
		).rejects.toThrow();
		await expect(source.globalLimit).toHaveValue("4");
		await source.globalLimit.fill("6");
		await source.globalLimit.press("Enter");
		await expect(source.globalLimit).toHaveValue("6");
		await expect(observer.globalLimit).toHaveValue("6");
		await expect(observer.workspaceLimit).toHaveAttribute("placeholder", "6");

		await source.workspaceLimit.fill("2");
		await source.workspaceLimit.press("Enter");
		for (const current of [source, observer]) {
			await expect(current.workspaceLimit).toHaveValue("2");
			await expect(current.limitSource).toHaveAttribute("data-source", "custom");
		}

		await wire.request("workspace.setSubagentMaxConcurrent", { id, value: null });
		for (const current of [source, observer]) {
			await expect(current.workspaceLimit).toHaveValue("");
			await expect(current.limitSource).toHaveAttribute("data-source", "global");
		}
		await wire.request("workspace.setSubagentMaxConcurrent", { id, value: 2 });
		await expect(source.workspaceLimit).toHaveValue("2");

		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openChatSettings(page);
		await expect(source.globalLimit).toHaveValue("6");
		await expect(source.workspaceLimit).toHaveValue("2");

		await wire.request("workspace.setSubagentMaxConcurrent", { id, value: null });
		for (const current of [source, observer]) {
			await expect(current.workspaceLimit).toHaveValue("");
			await expect(current.limitSource).toHaveAttribute("data-source", "global");
		}
	} finally {
		await restoreSubagentBaseline(page).catch(() => {});
		await peer?.close();
		wire.close();
	}
});

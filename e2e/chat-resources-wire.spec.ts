import { expect, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

test("resource catalogues enforce ownership and historical text grants no control", async ({
	page,
}) => {
	await openFixtureProject(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const project = (await wire.request("project.list", {}))[0];
		if (!project) throw new Error("Missing fixture project");
		const workspace = (await wire.request("workspace.list", { projectId: project.id })).find(
			(row) => row.kind === "default",
		);
		if (!workspace) throw new Error("Missing default workspace");
		const parent = seedWorkspaceSession(workspace.worktreePath, {
			name: "Resource history",
			messages: [
				{
					role: "user",
					text: "Historical command id: old-command; child id: old-child.",
					timestamp: Date.now(),
				},
			],
		});
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "Resource history");
		const scope = { workspaceId: workspace.id, sessionId: parent.id };
		expect(await wire.request("session.resources", scope)).toMatchObject({
			...scope,
			commands: [],
			subagents: [],
		});
		await expect(
			wire.request("session.resources", { ...scope, sessionId: "missing-parent" }),
		).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
		expect(await wire.request("session.resourceHistory", { ...scope, kind: "command" })).toEqual({
			kind: "command",
			items: [],
			hasMore: false,
		});
		expect(
			await wire.request("backgroundCommand.output", { ...scope, commandId: "old-command" }),
		).toEqual({ available: false });
		await expect(
			wire.request("backgroundCommand.stop", { ...scope, commandId: "old-command" }),
		).rejects.toThrow(/Resource unavailable/);
		await expect(
			wire.request("subagent.stop", {
				workspaceId: workspace.id,
				parentSessionId: parent.id,
				childSessionId: "old-child",
			}),
		).rejects.toThrow(/Resource unavailable/);
		expect(
			await wire.request("subagent.stopAll", {
				workspaceId: workspace.id,
				parentSessionId: parent.id,
			}),
		).toEqual({ ok: true, targeted: 0 });
		await expect(
			wire.request("subagent.getTranscript", {
				workspaceId: workspace.id,
				parentSessionId: parent.id,
				childSessionId: "old-child",
			}),
		).rejects.toThrow(/Resource unavailable/);
		await expect(wire.request("session.reloadResources", { sessionId: parent.id })).rejects.toThrow(
			"Select a model before reloading resources",
		);
		const model = (await wire.request("model.list", {}))[0];
		if (!model) throw new Error("Missing SDK model for the resource reload fixture");
		expect(await wire.request("session.setModel", { sessionId: parent.id, model })).toEqual({
			ok: true,
		});
		await expect(page.getByTestId("open-skills")).toBeVisible();
		await page.getByTestId("open-skills").click();
		await expect(page.getByTestId("skills-execution-unavailable")).toHaveCount(0);
		await expect(page.getByTestId("skills-reload")).toBeEnabled();
		await page.getByTestId("skills-reload").click();
		await expect(page.getByText("Skills reloaded", { exact: true })).toBeVisible();
		await expect(page.getByTestId("skills-reload")).toBeEnabled();
		await page.keyboard.press("Escape");
		const command = (await wire.request("session.getCommands", { sessionId: parent.id })).find(
			(entry) => entry.source === "skill",
		);
		if (!command) throw new Error("Missing admitted fixture Skill command");
		await page.getByTestId("chat-input").fill(`/${command.name}`);
		await expect(
			page.getByTestId("slash-command").filter({ hasText: `/${command.name}` }),
		).toBeVisible();
		await page.getByTestId("chat-input").fill("");
		await page.getByTestId("open-settings").click();
		await expect(page.getByTestId("settings-nav-mcp")).toBeVisible();
		await expect(page.getByTestId("settings-nav-extensions")).toBeVisible();
	} finally {
		wire.close();
	}
});

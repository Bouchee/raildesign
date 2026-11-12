import { expect, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

test("historical process text cannot expose unavailable resource execution endpoints", async ({
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
		await expect(wire.request("session.resources", scope)).rejects.toThrow(/Unknown method/);
		await expect(
			wire.request("session.resourceHistory", { ...scope, kind: "command" }),
		).rejects.toThrow(/Unknown method/);
		await expect(
			wire.request("backgroundCommand.output", { ...scope, commandId: "old-command" }),
		).rejects.toThrow(/Unknown method/);
		await expect(
			wire.request("backgroundCommand.stop", { ...scope, commandId: "old-command" }),
		).rejects.toThrow(/Unknown method/);
		await expect(
			wire.request("subagent.stop", {
				workspaceId: workspace.id,
				parentSessionId: parent.id,
				childSessionId: "old-child",
			}),
		).rejects.toThrow(/Unknown method/);
		await expect(
			wire.request("subagent.stopAll", { workspaceId: workspace.id, parentSessionId: parent.id }),
		).rejects.toThrow(/Unknown method/);
		await expect(page.getByTestId("open-skills")).toBeVisible();
		await page.getByTestId("open-skills").click();
		await expect(page.getByTestId("skills-execution-unavailable")).toBeVisible();
		await expect(page.getByTestId("skills-reload")).toBeDisabled();
		await page.keyboard.press("Escape");
		await page.getByTestId("open-settings").click();
		await expect(page.getByTestId("settings-nav-mcp")).toBeVisible();
		await expect(page.getByTestId("settings-nav-extensions")).toHaveCount(0);
	} finally {
		wire.close();
	}
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Workspace } from "@thinkrail/contracts";
import { activeWorktreeRow, expandActivityStep, openWorkspaceChat } from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

function persistedWorkspaces(): Workspace[] {
	return JSON.parse(readFileSync(join(E2E_DATA_DIR, "workspaces.json"), "utf8")) as Workspace[];
}

test(
	"a side-workspace request starts a real workspace whose chat runs, and status reports it",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(300_000);
		const spawner = await openWorkspaceChat(page);
		const before = new Set(persistedWorkspaces().map((workspace) => workspace.id));

		await page
			.getByTestId("chat-input")
			.fill(
				'Call start_workspace exactly once with prompt "Reply exactly SIDE_WORKSPACE_PROOF and use no tools.", project null, base_branch null, model null, effort null and attachments null. Then call workspace_status exactly once with the returned workspace ID in workspaces and project null. Do no other work.',
			);
		await page.getByTestId("chat-send").click();

		await expect
			.poll(() => persistedWorkspaces().filter((workspace) => !before.has(workspace.id)).length, {
				timeout: 120_000,
			})
			.toBe(1);
		const child = persistedWorkspaces().find((workspace) => !before.has(workspace.id));
		if (!child) throw new Error("start_workspace persisted no new workspace");
		expect(child.projectId).toBe(spawner.projectId);
		expect(child.worktreePath).not.toBe(spawner.worktreePath);
		const wire = await E2eWire.connect();
		try {
			const [parent] = await wire.request("session.list", { workspaceId: spawner.id });
			await expect
				.poll(async () => (await wire.request("session.list", { workspaceId: child.id })).length)
				.toBe(1);
			const [started] = await wire.request("session.list", { workspaceId: child.id });
			if (!parent || !started)
				throw new Error("The workspace tool did not create both SDK sessions");
			for (const [workspaceId, session] of [
				[spawner.id, parent],
				[child.id, started],
			] as const) {
				await expect
					.poll(
						async () => {
							const snapshot = await wire.request("session.getMessages", {
								workspaceId,
								sessionId: session.sessionId,
							});
							return snapshot.summary.state?.execution === "idle"
								? snapshot.summary.state.completion?.outcome
								: "running";
						},
						{ timeout: 150_000 },
					)
					.toBe("succeeded");
			}
			const result = await wire.request("session.getMessages", {
				workspaceId: child.id,
				sessionId: started.sessionId,
			});
			expect(
				JSON.stringify(result.messages.filter((message) => message.role === "assistant")),
			).toContain("SIDE_WORKSPACE_PROOF");
			const status = await expandActivityStep(page, "workspace_status");
			await expect(status).toContainText(child.id);
			const card = page.locator('[data-testid="tool-card"][data-tool="start_workspace"]').first();
			await expect(card).toBeVisible();
			await expect(card).toHaveAttribute("data-status", "done");
			await expect(card.getByTestId("tool-start-workspace")).toContainText("SIDE_WORKSPACE_PROOF");
			await card.getByTestId("start-workspace-open").click();
			await testInfo.attach("sdk-workspace-tools", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ spawner, child, result })),
			});
		} finally {
			wire.close();
		}
		await expect(activeWorktreeRow(page).getByTestId("workspace-name")).toHaveText(
			persistedWorkspaces().find((workspace) => workspace.id === child.id)?.name ?? child.name,
			{ timeout: 20_000 },
		);
		await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(1);
	},
);

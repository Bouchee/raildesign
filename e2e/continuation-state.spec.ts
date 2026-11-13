import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE, type Workspace } from "@thinkrail/contracts";
import { createWorkspaceViaDialog, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

for (const completed of [true, false]) {
	test(`a stored continuation ${completed ? "restores its completed status after reload" : "reports a lost operation and sends Retry"}`, async ({
		page,
	}) => {
		const retries: { workspaceId: string; projectId: string }[] = [];
		await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
			const server = browser.connectToServer();
			browser.onMessage((message) => {
				const frame = JSON.parse(message.toString()) as {
					id: string;
					method: string;
					params: { workspaceId: string; projectId: string };
				};
				if (frame.method === "chat.continue") {
					retries.push(frame.params);
					browser.send(
						JSON.stringify({ id: frame.id, ok: false, error: "Retry held by the fixture" }),
					);
				} else server.send(message);
			});
			server.onMessage((message) => browser.send(message));
		});
		await openFixtureProject(page);
		const destination = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		try {
			const source = await wire.request("chat.create", {});
			const operationId = "e2e-stored-continuation";
			seedWorkspaceSession(source.workspace.worktreePath, {
				id: "e2e-continuation-history",
				name: "Stored continuation",
				updatedAt: Date.now() + 1000,
				messages: [
					{ role: "user", text: "Continue the README work", timestamp: Date.now() },
					{
						id: "e2e-request-card",
						role: "custom",
						customType: CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE,
						display: true,
						content: [{ type: "text", text: "Continue the conversation in the project." }],
						details: {
							operationId,
							projectId: destination.projectId,
							projectName: "sample-project",
						},
						timestamp: Date.now() + 1,
					},
				],
			});
			if (completed) {
				const [target] = await wire.request("session.list", { workspaceId: destination.id });
				if (!target) throw new Error("The fixture destination has no session");
				const file = join(E2E_DATA_DIR, "chats.json");
				const record = JSON.parse(readFileSync(file, "utf8")) as { chats: Workspace[] };
				record.chats = record.chats.map((chat) =>
					chat.id === source.workspace.id
						? {
								...chat,
								continuedTo: [
									{
										operationId,
										projectId: destination.projectId,
										workspaceId: destination.id,
										sessionId: target.sessionId,
									},
								],
							}
						: chat,
				);
				writeFileSync(file, JSON.stringify(record));
			}
			await page.reload();
			await page.getByTestId("chat-item").getByRole("button").first().click();
			await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "chat");
			await openPersistedChat(page, "Stored continuation");
			const card = page.getByTestId("continuation-card");
			await expect(card).toHaveAttribute("data-phase", completed ? "started" : "lost");
			await page.reload();
			await expect(card).toHaveAttribute("data-phase", completed ? "started" : "lost");
			if (completed) await expect(card.getByTestId("continuation-open")).toBeVisible();
			else {
				await card.getByTestId("continuation-retry").click();
				await expect
					.poll(() => retries)
					.toEqual([{ workspaceId: source.workspace.id, projectId: destination.projectId }]);
			}
		} finally {
			wire.close();
		}
	});
}

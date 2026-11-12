import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

test("unavailable chat resources stay hidden without requesting execution catalogs", async ({
	page,
}) => {
	const reads: string[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string") return;
			const frame = JSON.parse(payload) as { method?: string };
			const method = frame.method;
			if (
				method &&
				["session.resources", "session.resourceHistory", "subagent.getTranscript"].includes(method)
			)
				reads.push(method);
		});
	});
	await openFixtureProject(page);
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "Resource history",
		messages: [
			{
				role: "user",
				text: "Historical process text does not establish a running resource.",
				timestamp: Date.now(),
			},
		],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, "Resource history");
	for (const testId of ["resources-trigger", "resources-inspector", "resources-dock"])
		await expect(page.getByTestId(testId)).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByTestId("chat-input")).toBeVisible();
	await page.getByTestId("chat-input").focus();
	await expect(page.getByTestId("chat-input")).toBeFocused();
	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("chat-toolbar")).toBeVisible();
	await expect(page.getByTestId("resources-trigger")).toHaveCount(0);
	expect(reads).toEqual([]);
});

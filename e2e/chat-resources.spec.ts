import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { E2E_DATA_DIR, E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

test("chat resources read their owned catalogue without authority from historical text", async ({
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
	await expect(page.getByTestId("resources-trigger")).toBeVisible();
	await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
	await expect(page.getByTestId("resources-dock")).toHaveCount(0);
	await page.getByTestId("resources-trigger").click();
	await expect(page.getByTestId("resources-inspector")).toBeVisible();
	await expect(page.getByTestId("resources-empty")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("resources-inspector")).toBeHidden();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByTestId("chat-input")).toBeVisible();
	await page.getByTestId("chat-input").focus();
	await expect(page.getByTestId("chat-input")).toBeFocused();
	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("chat-toolbar")).toBeVisible();
	await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
	expect(reads).toContain("session.resources");
	expect(reads).not.toContain("subagent.getTranscript");
});

test("a historical child card outside the resource window still opens its owned transcript reader", async ({
	page,
}) => {
	await openFixtureProject(page);
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "Historical child card",
		messages: [
			{ role: "user", text: "Inspect an earlier child result.", timestamp: Date.now() },
			{
				role: "assistant",
				timestamp: Date.now() + 1,
				content: [
					{
						type: "toolCall",
						id: "old-agent-call",
						name: "Agent",
						arguments: { subagent_type: "worker", task: "Earlier work" },
					},
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "old-agent-call",
				toolName: "Agent",
				timestamp: Date.now() + 2,
				content: [{ type: "text", text: "Earlier result" }],
				isError: false,
				details: {
					childSessionId: "missing-historical-child",
					task: "Earlier work",
					status: "completed",
					durationMs: 1,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 1,
						contextTokens: 0,
					},
				},
			},
		],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, "Historical child card");
	const card = page.locator('[data-testid="tool-card"][data-tool="Agent"]');
	if (!(await card.getByTestId("agent-open-transcript").isVisible()))
		await card.getByTestId("tool-card-toggle").click();
	await card.getByTestId("agent-open-transcript").click();
	const dialog = page.getByTestId("subagent-transcript-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("alert")).toContainText("Resource unavailable");
	await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("parent resources read a completed child's command log with its actual owner", async ({
	page,
}) => {
	await openFixtureProject(page);
	const cwd = realpathSync(E2E_FIXTURE_REPO);
	const parent = seedWorkspaceSession(cwd, {
		name: "Child command history",
		messages: [{ role: "user", text: "Inspect child output", timestamp: Date.now() }],
	});
	const child = seedWorkspaceSession(cwd, { name: "Hidden child", messages: [] });
	const record = JSON.parse(readFileSync(child.path, "utf8"));
	record.childRun = {
		parentSessionId: parent.id,
		toolCallId: "fixture-child",
		task: "Produce output",
		definition: {
			name: "worker",
			description: "Fixture worker",
			source: "builtin",
			systemPrompt: "Fixture child",
		},
		enabledExtensions: [],
		detached: true,
		createdAt: new Date().toISOString(),
		status: "completed",
		finishedAt: Date.now(),
		completionDelivered: true,
		collected: true,
	};
	writeFileSync(child.path, JSON.stringify(record));
	const directory = join(E2E_DATA_DIR, "resource-history", record.workspaceId, child.id);
	mkdirSync(join(directory, "logs"), { recursive: true });
	const command = {
		id: "child-history-command",
		sessionId: child.id,
		name: "Child command output",
		command: "fixture",
		status: "completed",
		startedAt: 1,
		finishedAt: 2,
		exitCode: 0,
	};
	writeFileSync(
		join(directory, "index.jsonl"),
		`${JSON.stringify({ kind: "command", summary: command })}\n`,
	);
	writeFileSync(
		join(directory, "logs", `${command.id}.json`),
		JSON.stringify({ text: "CHILD_OWNED_LOG", truncated: false }),
	);
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, "Child command history");
	await page.getByTestId("resources-trigger").click();
	const row = page.getByTestId("resource-command").filter({ hasText: "Child command output" });
	await expect(row).toBeVisible();
	await row.getByRole("option").click();
	await expect(page.getByTestId("command-log-output")).toContainText("CHILD_OWNED_LOG");
	await expect(row.getByTestId("resource-stop")).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await page.getByTestId("resources-trigger").click();
	await row.getByRole("option").click();
	await expect(page.getByTestId("command-log-output")).toContainText("CHILD_OWNED_LOG");
});

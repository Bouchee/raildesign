import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, revealWorkbenchTool } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

test(
	"SDK task edits the selected worktree, runs a test and displays its real Diff",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await openFixtureProject(page);
		const peer = await createWorkspaceViaDialog(page);
		const selected = await createWorkspaceViaDialog(page);
		const expected = "SDK_STAGE1_PROOF\n";
		const command = 'test "$(cat notes.txt)" = "SDK_STAGE1_PROOF" && printf SDK_TEST_PASS';
		const wire = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: selected.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("The selected worktree has no chat session");
			await page
				.getByTestId("chat-input")
				.fill(
					`Use read to read notes.txt. Use apply_patch to replace its exact original text with SDK_STAGE1_PROOF followed by one newline. Then use bash with exactly this command and timeoutMs 10000: ${command}. Do not change any other file. Finish with DONE.`,
				);
			await page.getByTestId("chat-send").click();
			const approved = new Set<string>();
			let reloadedApproval = false;
			await expect
				.poll(
					async () => {
						const snapshot = await wire.request("session.getMessages", {
							workspaceId: selected.id,
							sessionId,
						});
						const pending = snapshot.summary.state?.needsInput;
						if (
							pending?.kind === "dialog" &&
							pending.request.kind === "confirm" &&
							!approved.has(pending.interactionId)
						) {
							const input = pending.request.toolInput;
							const allowed = input?.path === "notes.txt" || input?.command === command;
							if (!reloadedApproval) {
								await page.reload();
								await expect(page.getByTestId("connection-status")).toHaveAttribute(
									"data-status",
									"connected",
								);
								reloadedApproval = true;
							}
							const prompt = page
								.getByTestId("ext-ui-prompt")
								.filter({ has: page.getByTestId("ext-ui-submit") });
							await expect(prompt).toBeVisible();
							if (!allowed) {
								await prompt.getByTestId("ext-ui-cancel").click();
								throw new Error(
									"The live agent requested an action outside this acceptance scenario",
								);
							}
							approved.add(pending.interactionId);
							await prompt.getByTestId("ext-ui-submit").click();
						}
						return snapshot.summary.state?.completion?.outcome;
					},
					{ timeout: 120_000, intervals: [250, 500] },
				)
				.toBe("succeeded");
			expect(approved.size).toBeGreaterThanOrEqual(2);
			expect(readFileSync(join(selected.worktreePath, "notes.txt"), "utf8")).toBe(expected);
			expect(readFileSync(join(peer.worktreePath, "notes.txt"), "utf8")).toBe(
				"plain-text-fixture\n",
			);
			expect(readFileSync(join(E2E_FIXTURE_REPO, "notes.txt"), "utf8")).toBe(
				"plain-text-fixture\n",
			);
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: selected.id,
				sessionId,
			});
			expect(
				snapshot.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "bash" &&
						JSON.stringify(message.content).includes("SDK_TEST_PASS"),
				),
			).toBe(true);
			await revealWorkbenchTool(page, "changes");
			const change = page.getByTestId("change-item").filter({ hasText: "notes.txt" });
			await expect(change).toHaveAttribute("data-status", "modified");
			await change.dblclick();
			await expect(page.getByTestId("diff-view")).toContainText("SDK_STAGE1_PROOF");
			await testInfo.attach("stage1-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{
							sessionId,
							selected,
							peer,
							state: snapshot.summary.state,
							eventSeq: snapshot.summary.eventSeq,
							model: snapshot.summary.model,
							approvals: [...approved],
							reloadedApproval,
							toolResults: snapshot.messages.filter((message) => message.role === "toolResult"),
							selectedText: readFileSync(join(selected.worktreePath, "notes.txt"), "utf8"),
							peerText: readFileSync(join(peer.worktreePath, "notes.txt"), "utf8"),
						},
						null,
						2,
					),
				),
			});
			await page.screenshot({ path: testInfo.outputPath("raildesign-stage1.png") });
		} finally {
			wire.close();
		}
	},
);

test(
	"Stop cancels an approved SDK command through the current UI",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		await openFixtureProject(page);
		const workspace = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		const command =
			"printf READY > sdk-stop-started.marker; sleep 30; printf AFTER > sdk-stop-completed.marker";
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("No chat session");
			await page
				.getByTestId("chat-input")
				.fill(
					`Use bash exactly once with timeoutMs 60000 and this exact command: ${command}. Do not use any other tool.`,
				);
			await page.getByTestId("chat-send").click();
			await expect(page.getByTestId("ext-ui-prompt")).toBeVisible({ timeout: 60_000 });
			const waiting = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			const pending = waiting.summary.state?.needsInput;
			expect(pending?.kind === "dialog" && pending.request.toolInput?.command).toBe(command);
			await page.getByTestId("ext-ui-submit").click();
			await expect
				.poll(() => existsSync(join(workspace.worktreePath, "sdk-stop-started.marker")))
				.toBe(true);
			await expect(page.getByTestId("stream-indicator")).toHaveAttribute(
				"data-phase",
				"running-tool",
			);
			await page.getByTestId("chat-abort").click();
			await expect
				.poll(
					async () =>
						(await wire.request("session.getMessages", { workspaceId: workspace.id, sessionId }))
							.summary.state?.completion?.outcome,
				)
				.toBe("cancelled");
			expect(existsSync(join(workspace.worktreePath, "sdk-stop-completed.marker"))).toBe(false);
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(
				snapshot.messages.some(
					(message) =>
						message.role === "toolResult" && message.toolName === "bash" && message.isError,
				),
			).toBe(true);
			await testInfo.attach("stop-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{
							state: snapshot.summary.state,
							toolResults: snapshot.messages.filter((message) => message.role === "toolResult"),
						},
						null,
						2,
					),
				),
			});
		} finally {
			wire.close();
		}
	},
);

test(
	"rejecting an SDK patch in the UI leaves the worktree unchanged",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		await openFixtureProject(page);
		const workspace = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("No chat session");
			await page
				.getByTestId("chat-input")
				.fill(
					"Use read to read notes.txt, then propose exactly one apply_patch replacing its text with REJECTED_EDIT and a newline. If approval is denied, do not retry and finish with REJECTED. Do not use bash or change any other file.",
				);
			await page.getByTestId("chat-send").click();
			await expect(page.getByTestId("ext-ui-prompt")).toBeVisible({ timeout: 60_000 });
			const waiting = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			const pending = waiting.summary.state?.needsInput;
			expect(pending?.kind === "dialog" && pending.request.toolInput?.path).toBe("notes.txt");
			await page.getByTestId("ext-ui-cancel").click();
			await expect
				.poll(
					async () =>
						(await wire.request("session.getMessages", { workspaceId: workspace.id, sessionId }))
							.summary.state?.completion?.outcome,
					{ timeout: 60_000 },
				)
				.toBeTruthy();
			expect(readFileSync(join(workspace.worktreePath, "notes.txt"), "utf8")).toBe(
				"plain-text-fixture\n",
			);
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(
				snapshot.messages.some(
					(message) =>
						message.role === "toolResult" && message.toolName === "apply_patch" && message.isError,
				),
			).toBe(true);
			await testInfo.attach("rejection-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{
							state: snapshot.summary.state,
							toolResults: snapshot.messages.filter((message) => message.role === "toolResult"),
						},
						null,
						2,
					),
				),
			});
		} finally {
			wire.close();
		}
	},
);

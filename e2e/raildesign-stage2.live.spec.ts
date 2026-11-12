import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { WsParams } from "@thinkrail/contracts";
import { createWorkspaceViaDialog, openFixtureProject } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test(
	"queued input survives refresh and two clients apply one approval once",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await openFixtureProject(page);
		const workspace = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		const peer = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("The queue test chat has no session ID");
			const command = "printf 'S2_EFFECT\\n' >> stage2-effect.marker";
			await page
				.getByTestId("chat-input")
				.fill(
					`Use bash exactly once, timeoutMs 10000, command exactly: ${command}. Do not use any other tool. Then finish with INITIAL_DONE.`,
				);
			await page.getByTestId("chat-send").click();
			await expect(page.getByTestId("ext-ui-prompt")).toBeVisible({ timeout: 60_000 });
			await wire.request("session.followUp", {
				sessionId,
				messageId: "stage2-followup",
				text: "Reply only FOLLOWUP_FINISHED. Do not use any tools.",
			});
			await wire.request("session.steer", {
				sessionId,
				messageId: "stage2-steering",
				text: "After the requested bash returns, reply STEERING_APPLIED. Do not use any more tools.",
			});
			const waiting = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			const pending = waiting.summary.state?.needsInput;
			if (pending?.kind !== "dialog" || pending.request.kind !== "confirm")
				throw new Error("The SDK did not pause for tool approval");
			const { runId, revision, toolCallId } = pending.request;
			if (!runId || revision === undefined || !toolCallId)
				throw new Error("The tool approval has incomplete ownership");
			expect(pending.request.toolInput?.command).toBe(command);
			expect(waiting.summary.queue?.steering.map((input) => input.id)).toEqual(["stage2-steering"]);
			expect(waiting.summary.queue?.followUp.map((input) => input.id)).toEqual(["stage2-followup"]);
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			await expect(page.getByTestId("ext-ui-prompt")).toBeVisible();
			await expect(page.getByTestId("queue-item")).toHaveCount(2);
			await expect(page.getByTestId("stream-indicator")).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath("stage2-pending-queue.png") });
			const peerSnapshot = await peer.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(peerSnapshot.messages).toEqual(waiting.messages);
			expect(peerSnapshot.summary.queue).toEqual(waiting.summary.queue);
			expect(peerSnapshot.summary.state?.needsInput).toEqual(pending);
			const response = {
				id: pending.interactionId,
				sessionId,
				runId,
				revision,
				toolCallId,
				value: true,
			};
			await Promise.all([
				wire.request("session.extUiReply", { response }),
				peer.request("session.extUiReply", { response }),
			]);
			await expect
				.poll(
					async () => {
						const snapshot = await wire.request("session.getMessages", {
							workspaceId: workspace.id,
							sessionId,
						});
						return (
							snapshot.summary.state?.completion?.outcome === "succeeded" &&
							snapshot.summary.state.queuedCount === 0 &&
							snapshot.messages.some(
								(message) =>
									message.role === "assistant" &&
									JSON.stringify(message.content).includes("FOLLOWUP_FINISHED"),
							)
						);
					},
					{ timeout: 120_000, intervals: [250, 500] },
				)
				.toBe(true);
			expect(readFileSync(join(workspace.worktreePath, "stage2-effect.marker"), "utf8")).toBe(
				"S2_EFFECT\n",
			);
			const finished = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			const followUpIndex = finished.messages.findIndex(
				(message) => message.id === "stage2-followup",
			);
			expect(
				finished.messages
					.slice(0, followUpIndex)
					.some(
						(message) =>
							message.role === "assistant" &&
							JSON.stringify(message.content).includes("STEERING_APPLIED"),
					),
			).toBe(true);
			for (const id of ["stage2-steering", "stage2-followup"])
				expect(
					finished.messages.filter((message) => message.id === id && message.role === "user"),
				).toHaveLength(1);
			expect(
				finished.messages.findIndex((message) => message.id === "stage2-steering"),
			).toBeLessThan(finished.messages.findIndex((message) => message.id === "stage2-followup"));
			await wire.request("session.extUiReply", { response });
			await expect(
				peer.request("session.extUiReply", { response: { ...response, value: false } }),
			).rejects.toThrow();
			expect(readFileSync(join(workspace.worktreePath, "stage2-effect.marker"), "utf8")).toBe(
				"S2_EFFECT\n",
			);
			await testInfo.attach("queue-approval-proof", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ waiting, finished, effect: "S2_EFFECT\n" }, null, 2)),
			});
		} finally {
			wire.close();
			peer.close();
		}
	},
);

test(
	"question answers survive refresh and repeated responses do not resume twice",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(150_000);
		const replies: WsParams<"session.respondToTool">[] = [];
		page.on("websocket", (socket) =>
			socket.on("framesent", (sent) => {
				const frame: { method?: string; params?: WsParams<"session.respondToTool"> } = JSON.parse(
					sent.payload.toString(),
				);
				if (frame.method === "session.respondToTool" && frame.params) replies.push(frame.params);
			}),
		);
		await openFixtureProject(page);
		const workspace = await createWorkspaceViaDialog(page);
		const wire = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("The question test chat has no session ID");
			const args = {
				questions: [
					{
						header: "Alloy",
						question: "Choose the vessel alloy.",
						multiSelect: false,
						options: [
							{ label: "Titanium", description: "Use titanium." },
							{ label: "Steel", description: "Use steel." },
						],
					},
				],
			};
			await page
				.getByTestId("chat-input")
				.fill(
					`Call ask_user_question exactly once with these arguments: ${JSON.stringify(args)}. Use no other tools. Wait for the answer, then state the chosen alloy in one short sentence.`,
				);
			await page.getByTestId("chat-send").click();
			const card = page.locator('[data-testid="ask-user-question"][data-tone="active"]').first();
			await expect(card).toBeVisible({ timeout: 60_000 });
			const before = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			expect(before.summary.state?.needsInput?.kind).toBe("tool-response");
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			await expect(card).toBeVisible();
			const restored = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			expect(restored.summary.state?.needsInput).toEqual(before.summary.state?.needsInput);
			await card.getByTestId("ask-option").filter({ hasText: "Titanium" }).click();
			await card.getByTestId("ask-submit").click();
			await expect.poll(() => replies.length).toBe(1);
			await expect(
				page.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
			).toContainText(/titanium/i, { timeout: 60_000 });
			await expect
				.poll(
					async () =>
						(await wire.request("session.getMessages", { sessionId, workspaceId: workspace.id }))
							.summary.state?.completion?.outcome,
				)
				.toBe("succeeded");
			const response = replies[0];
			if (!response) throw new Error("The question card sent no anchored response");
			await wire.request("session.respondToTool", response);
			await expect(
				wire.request("session.respondToTool", { ...response, runId: "another-run" }),
			).rejects.toThrow();
			const finished = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			expect(
				finished.messages.filter(
					(message) => message.role === "toolResult" && message.toolName === "ask_user_question",
				),
			).toHaveLength(1);
			await testInfo.attach("question-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{ sessionId, pending: before.summary.state?.needsInput, response, finished },
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

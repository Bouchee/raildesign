import { expect, test } from "@playwright/test";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import { openWorkspaceChat, revealWorkbenchTool, waitForAgentSettled } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test(
	"the agent maintains the chat's TODO plan live, and picks up a user-added item",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		let addedId: string | undefined;
		page.on("websocket", (socket) => {
			if (!/\/ws(\?|$)/.test(socket.url())) return;
			const additions = new Set<string>();
			socket.on("framesent", ({ payload }) => {
				const frame = JSON.parse(payload.toString()) as { id: string; method?: string };
				if (frame.method === "todo.add") additions.add(frame.id);
			});
			socket.on("framereceived", ({ payload }) => {
				const frame = JSON.parse(payload.toString()) as {
					id?: string;
					ok?: boolean;
					result?: { id?: string };
				};
				if (frame.id && additions.has(frame.id) && frame.ok && typeof frame.result?.id === "string")
					addedId = frame.result.id;
			});
		});
		const workspace = await openWorkspaceChat(page);

		await page
			.getByTestId("chat-input")
			.fill(
				'Use todo_write to create a TODO plan with one group titled "Demo" containing exactly two items titled "Alpha" and "Beta". Then do no other work — just mark both done with todo_update.',
			);
		await page.getByTestId("chat-send").click();
		await waitForAgentSettled(page, 150_000);

		await revealWorkbenchTool(page, "plan");
		const popover = page.getByTestId("plan-rail-pane");
		const doneGroup = popover.getByTestId("todo-group-done").filter({ hasText: "Demo" });
		await expect(doneGroup).toBeVisible({ timeout: 15_000 });
		await doneGroup.click();
		await expect(popover.getByTestId("todo-row").filter({ hasText: "Alpha" })).toHaveAttribute(
			"data-status",
			"done",
		);
		await expect(popover.getByTestId("todo-row").filter({ hasText: "Beta" })).toHaveAttribute(
			"data-status",
			"done",
		);

		await popover.getByTestId("todo-add-input").fill("Reply with the single word ACK");
		await popover.getByTestId("todo-add-input").press("Enter");
		await expect.poll(() => addedId).toBeTruthy();
		const wire = await E2eWire.connect();
		try {
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			const sessionId = sessions[0]?.sessionId;
			if (!sessionId) throw new Error("The TODO probe has no session");
			await expect
				.poll(
					async () => {
						const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
						const loose = plan.todos.find((todo) => todo.id === addedId);
						const group = plan.groups.find((entry) => entry.id === addedId);
						return (
							loose?.status ??
							(group?.todos.length && group.todos.every((todo) => todo.status === "done")
								? "done"
								: "pending")
						);
					},
					{ timeout: 120_000 },
				)
				.toBe("done");
			await expect
				.poll(
					async () => {
						const result = await wire.request("session.getMessages", {
							workspaceId: workspace.id,
							sessionId,
						});
						return result.summary.state?.execution === "idle"
							? result.summary.state.completion?.outcome
							: "running";
					},
					{ timeout: 60_000 },
				)
				.toBe("succeeded");
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			const loose = plan.todos.find((todo) => todo.id === addedId);
			const promoted = plan.groups.find((group) => group.id === addedId);
			const completed = loose ? [loose] : (promoted?.todos ?? []);
			expect(completed.length).toBeGreaterThan(0);
			expect(completed.every((todo) => todo.status === "done")).toBe(true);
			const collapsed = popover.locator('[data-testid="todo-group-done"][data-expanded="false"]');
			while ((await collapsed.count()) > 0) await collapsed.first().click();
			for (const todo of completed)
				await expect(
					popover.getByTestId("todo-row").filter({ hasText: todo.title }).first(),
				).toHaveAttribute("data-status", "done");
			await expect(
				page
					.locator('[data-testid="chat-message"][data-role="user"]')
					.filter({ hasText: "TODO was added" }),
			).toHaveCount(0);
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(
				snapshot.messages.some(
					(message) =>
						message.role === "toolResult" && message.toolName === "todo_list" && !message.isError,
				),
			).toBe(true);
			expect(
				snapshot.messages.filter(
					(message) =>
						message.role === "user" && JSON.stringify(message.content).includes(TODO_NUDGE_PREFIX),
				),
			).toHaveLength(0);
			await page.reload();
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			await testInfo.attach("sdk-todo-nudge", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ addedId, plan, snapshot })),
			});
		} finally {
			wire.close();
		}
	},
);

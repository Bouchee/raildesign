import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Workspace, WsResult } from "@thinkrail/contracts";
import { openWorkspaceChat, revealWorkbenchTool } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

async function parentSession(wire: E2eWire, workspace: Workspace): Promise<string> {
	const sessions = await wire.request("session.list", { workspaceId: workspace.id });
	const sessionId = sessions[0]?.sessionId;
	if (!sessionId) throw new Error("The Stage 3 workspace has no parent session");
	return sessionId;
}

async function send(page: Page, text: string): Promise<void> {
	await page.getByTestId("chat-input").fill(text);
	await page.getByTestId("chat-send").click();
}

async function settle(
	wire: E2eWire,
	workspaceId: string,
	sessionId: string,
	allow: (input: Record<string, unknown>) => boolean = () => false,
): Promise<WsResult<"session.getMessages">> {
	const answered = new Set<string>();
	await expect
		.poll(
			async () => {
				const snapshot = await wire.request("session.getMessages", { workspaceId, sessionId });
				const pending = snapshot.summary.state?.needsInput;
				if (pending?.kind === "dialog" && !answered.has(pending.interactionId)) {
					const request = pending.request;
					if (
						request.kind !== "confirm" ||
						!request.runId ||
						!request.toolCallId ||
						request.revision === undefined
					)
						throw new Error("The Stage 3 probe received an unexpected interaction");
					const accepted = allow(request.toolInput ?? {});
					answered.add(pending.interactionId);
					await wire.request("session.extUiReply", {
						response: {
							id: request.id,
							sessionId,
							runId: request.runId,
							toolCallId: request.toolCallId,
							revision: request.revision,
							value: accepted,
						},
					});
					if (!accepted)
						throw new Error("The model requested an effect outside this Stage 3 probe");
				}
				return snapshot.summary.state?.execution === "idle"
					? snapshot.summary.state.completion?.outcome
					: "running";
			},
			{ timeout: 150_000, intervals: [250, 500] },
		)
		.toBe("succeeded");
	return wire.request("session.getMessages", { workspaceId, sessionId });
}

test(
	"SDK Skills, instructions, Plan and Spec have real effects that survive refresh",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		try {
			await wire.request("project.setTrust", {
				id: workspace.projectId,
				trusted: true,
				resources: true,
			});
			const skill = join(workspace.worktreePath, ".raildesign/skills/stage3-proof");
			mkdirSync(skill, { recursive: true });
			writeFileSync(
				join(skill, "SKILL.md"),
				"---\nname: stage3-proof\ndescription: Stage 3 tool connection probe\n---\nAfter the requested tool effects, include STAGE3_SKILL_BODY_READ in your final answer.\n",
			);
			writeFileSync(
				join(workspace.worktreePath, "AGENTS.md"),
				"For the Stage 3 probe, include STAGE3_WORKSPACE_RULE_READ in the final answer.\n",
			);
			await send(
				page,
				"/skill:stage3-proof This is a bounded tool connection probe. Use skill_read with name stage3-proof and path null. Use todo_write to create one group titled SDK Stage3 with one pending item titled Read workspace Skill. Use spec_create once with path stage3/SPEC.md, id stage3-proof, type module-design, title SDK Stage3 and status draft. Do no other work. Follow the Skill and workspace instructions in your final answer.",
			);
			const snapshot = await settle(
				wire,
				workspace.id,
				sessionId,
				(input) => input.path === "stage3/SPEC.md",
			);
			for (const name of ["skill_read", "todo_write", "spec_create"])
				expect(
					snapshot.messages.some(
						(message) =>
							message.role === "toolResult" && message.toolName === name && !message.isError,
					),
				).toBe(true);
			const final = snapshot.messages.filter((message) => message.role === "assistant").at(-1);
			expect(JSON.stringify(final?.content)).toContain("STAGE3_SKILL_BODY_READ");
			expect(JSON.stringify(final?.content)).toContain("STAGE3_WORKSPACE_RULE_READ");
			expect(readFileSync(join(workspace.worktreePath, "stage3/SPEC.md"), "utf8")).toContain(
				"id: stage3-proof",
			);
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			expect(JSON.stringify(plan)).toContain("Read workspace Skill");
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			await revealWorkbenchTool(page, "plan");
			await expect(page.getByTestId("plan-rail-pane")).toContainText("SDK Stage3");
			await page.screenshot({ path: testInfo.outputPath("stage3-skill-plan-spec.png") });
			await testInfo.attach("stage3-skill-plan-spec", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ snapshot, plan })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

test(
	"a background command survives refresh and parent Stop retains its output",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		const command = "printf 'STAGE3_BACKGROUND_READY\\n'; sleep 60";
		try {
			await send(
				page,
				`Call background_command exactly once with action start, name Stage3 background, timeout 90, command exactly: ${command}. Then reply STARTED. Do not wait, poll or call another tool.`,
			);
			await settle(wire, workspace.id, sessionId, (input) => input.command === command);
			const resources = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			const running = resources.commands.find((entry) => entry.name === "Stage3 background");
			if (!running) throw new Error("The model did not start the background command");
			expect(running.status).toBe("running");
			await expect
				.poll(async () => {
					const result = await wire.request("backgroundCommand.output", {
						workspaceId: workspace.id,
						sessionId,
						commandId: running.id,
					});
					return result.available ? result.output.text : "";
				})
				.toContain("STAGE3_BACKGROUND_READY");
			await page.reload();
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "1");
			await wire.request("session.abort", { sessionId });
			await expect
				.poll(async () => {
					const stopped = await wire.request("session.resources", {
						workspaceId: workspace.id,
						sessionId,
					});
					return stopped.commands.find((entry) => entry.id === running.id)?.status;
				})
				.toBe("stopped");
			const output = await wire.request("backgroundCommand.output", {
				workspaceId: workspace.id,
				sessionId,
				commandId: running.id,
			});
			expect(output.available && output.output.text.includes("STAGE3_BACKGROUND_READY")).toBe(true);
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
			await testInfo.attach("stage3-background-stop", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ resources, output })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

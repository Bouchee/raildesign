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

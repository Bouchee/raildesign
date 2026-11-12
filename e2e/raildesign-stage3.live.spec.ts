import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Workspace, WsResult } from "@thinkrail/contracts";
import { expandActivityStep, openWorkspaceChat, revealWorkbenchTool } from "./fixtures/app";
import { commitFile } from "./fixtures/git";
import { E2E_DATA_DIR } from "./fixtures/paths";
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

test(
	"SDK web tools call DeepSeek Search and Fetch and display their real results",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		const configuration = process.env.RAILDESIGN_DEEPSEEK_E2E_CONFIG;
		if (!configuration)
			throw new Error("Set RAILDESIGN_DEEPSEEK_E2E_CONFIG for the Stage 3 web acceptance test");
		if ((statSync(configuration).mode & 0o077) !== 0)
			throw new Error("The web acceptance configuration must be owner-only");
		const config: unknown = JSON.parse(readFileSync(configuration, "utf8"));
		if (
			!config ||
			typeof config !== "object" ||
			!("apiKey" in config) ||
			typeof config.apiKey !== "string" ||
			!("baseURL" in config) ||
			config.baseURL !== "https://api.deepseek.com"
		)
			throw new Error(
				"The web acceptance configuration must select the authorized DeepSeek endpoint",
			);
		const path = join(E2E_DATA_DIR, "web-access.json");
		writeFileSync(path, JSON.stringify({ apiKey: config.apiKey }), { mode: 0o600 });
		try {
			expect(await wire.request("webAccess.status", {})).toEqual({ configured: true });
			await send(
				page,
				'This is a web tool probe. Call web_search once with query "DeepSeek" and count 1. Call web_fetch once with url "https://api-docs.deepseek.com/guides/search/". Call no other tools. Then reply WEB_TOOLS_DONE.',
			);
			const snapshot = await settle(wire, workspace.id, sessionId);
			await testInfo.attach("stage3-web-results", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(snapshot)),
			});
			for (const name of ["web_search", "web_fetch"]) {
				const result = snapshot.messages.find(
					(message) => message.role === "toolResult" && message.toolName === name,
				);
				if (result?.role !== "toolResult") throw new Error(`The model did not call ${name}`);
				expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
				expect(result.details).toMatchObject({ provider: "DeepSeek" });
				if (name === "web_search")
					expect(result.details).toMatchObject({
						results: expect.arrayContaining([expect.objectContaining({ url: expect.any(String) })]),
					});
				else {
					expect(result.details).toMatchObject({
						url: "https://api-docs.deepseek.com/guides/search/",
					});
					expect(JSON.stringify(result.content).length).toBeGreaterThan(200);
				}
			}
			const search = await expandActivityStep(page, "web_search");
			await expect(search.getByTestId("tool-web_search")).toBeVisible();
			const fetched = await expandActivityStep(page, "web_fetch");
			await expect(fetched.getByTestId("tool-web_fetch")).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath("stage3-deepseek-web.png") });
		} finally {
			rmSync(path, { force: true });
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

test(
	"the Plan review button runs an independent SDK child and restores its verdict",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		try {
			await wire.request("settings.update", { config: { reviewAutoFix: false } });
			const sha = commitFile(
				workspace.worktreePath,
				"stage3-review.ts",
				"export const stage3Value = 3;\n",
				"feat: export stage3Value",
			);
			const directory = join(workspace.worktreePath, ".raildesign/context/todos");
			mkdirSync(directory, { recursive: true });
			const now = new Date().toISOString();
			writeFileSync(
				join(directory, `${sessionId}.json`),
				JSON.stringify({
					version: 6,
					groups: [],
					todos: [
						{
							id: "t_stage3_review",
							title: "Export stage3Value with value 3",
							note: "Add a module that exports the numeric constant stage3Value = 3. No callers are required.",
							status: "done",
							origin: "agent",
							artifacts: [{ kind: "commit", sha, label: "Export stage3Value" }],
							createdAt: now,
							updatedAt: now,
						},
					],
				}),
			);
			await revealWorkbenchTool(page, "plan");
			await page.getByTestId("plan-rail-pane").getByTestId("todo-open-plan").click();
			const item = page.locator("#plan-item-t_stage3_review");
			await expect(item.getByTestId("plan-start-review")).toBeEnabled();
			await item.hover();
			await item.getByTestId("plan-start-review").click();
			await expect
				.poll(
					async () => {
						const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
						return plan.todos.find((todo) => todo.id === "t_stage3_review")?.review?.state;
					},
					{ timeout: 180_000, intervals: [250, 500] },
				)
				.toMatch(/^(reviewed|changes_requested)$/);
			const resources = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			const reviewer = resources.subagents.find((child) => child.roleName === "Plan reviewer");
			if (!reviewer) throw new Error("The review button did not create its owned SDK child");
			expect(reviewer.status).toBe("completed");
			const transcript = await wire.request("subagent.getTranscript", {
				workspaceId: workspace.id,
				parentSessionId: sessionId,
				childSessionId: reviewer.childSessionId,
			});
			expect(transcript.messages.some((message) => message.role === "assistant")).toBe(true);
			expect(JSON.stringify(transcript.messages)).toContain("verdict");
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			await page.reload();
			await expect(page.locator("#plan-item-t_stage3_review")).toHaveAttribute(
				"data-reviewing",
				"false",
			);
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			await testInfo.attach("stage3-plan-review", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ plan, resources, transcript })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

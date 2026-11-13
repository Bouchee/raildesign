import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expandAllRoutineGroups, openWorkspaceChat, waitForAgentSettled } from "./fixtures/app";
import { resolveBunExecutable } from "./fixtures/executables";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { shot } from "./fixtures/screenshots";
import { E2eWire } from "./fixtures/wire";

const STDIO_SERVER = fileURLToPath(
	new URL("../packages/server/src/agent/mcp/fixtures/stdioServer.ts", import.meta.url),
);
const USER_CONFIG = join(E2E_DATA_DIR, "mcp.json");
const TOOL = "mcp__fixture__write_note";

async function send(page: Page, prompt: string) {
	await page.getByTestId("chat-input").fill(prompt);
	await page.getByTestId("chat-send").click();
}

test("an MCP call asks on its card; Always allow runs it unasked from then on until revoked in Settings", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(300_000);
	writeFileSync(
		USER_CONFIG,
		JSON.stringify({
			mcpServers: {
				fixture: { command: resolveBunExecutable(), args: [STDIO_SERVER], exposure: "direct" },
			},
		}),
	);
	try {
		await openWorkspaceChat(page);
		await send(
			page,
			`This is a tool-permission probe, not a coding task. Call the ${TOOL} tool exactly once with text "first". Do not call any other tool.`,
		);
		const step = page.locator(`[data-testid="activity-step"][data-tool="${TOOL}"]`).first();
		const prompt = step.getByTestId("ext-ui-prompt");
		await expect(prompt).toBeVisible({ timeout: 180_000 });
		await expect(prompt.getByTestId("ext-ui-option")).toHaveText([
			"Deny",
			"Allow once",
			"Allow in this chat",
			"Always allow",
		]);
		const input = prompt.getByTestId("ext-ui-tool-input");
		await expect(input.locator("dt")).toHaveText(["text"]);
		await expect(input.locator("dd")).toHaveText(["first"]);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await shot(step, "mcp-approval", "asks-on-card");
		await prompt.getByTestId("ext-ui-option").filter({ hasText: "Always allow" }).click();
		await waitForAgentSettled(page, 180_000);
		await expandAllRoutineGroups(page);
		await expect(step).toHaveAttribute("data-status", "done");

		await page.getByTestId("new-chat").first().click();
		await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(2);
		await send(
			page,
			`This is a tool-permission probe, not a coding task. Call the ${TOOL} tool exactly once with text "second". Do not call any other tool.`,
		);
		await waitForAgentSettled(page, 180_000);
		await expandAllRoutineGroups(page);
		const again = page.locator(`[data-testid="activity-step"][data-tool="${TOOL}"]`).first();
		await expect(again).toHaveAttribute("data-status", "done");
		await expect(page.getByTestId("ext-ui-prompt")).toHaveCount(0);

		await page.getByTestId("open-settings").click();
		await page.getByTestId("settings-nav-mcp").click();
		const row = page.locator('[data-testid="mcp-server-row"][data-name="fixture"]');
		const allowed = row.getByTestId("mcp-always-allowed-tool");
		await expect(allowed).toHaveAttribute("data-tool", TOOL);
		await expect(allowed).toContainText("write_note");
		await shot(row, "mcp-approval", "always-allowed-in-settings");
		await row.getByTestId("mcp-always-allowed-revoke").click();
		await expect(row.getByTestId("mcp-always-allowed")).toHaveCount(0);
	} finally {
		rmSync(USER_CONFIG, { force: true });
	}
});

test(
	"SDK MCP resource tools list, read and restore their real server results",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		writeFileSync(
			USER_CONFIG,
			JSON.stringify({
				mcpServers: {
					fixture: {
						command: resolveBunExecutable(),
						args: [STDIO_SERVER],
						exposure: "direct",
						env: { MCP_FIXTURE_RESOURCES: "1" },
					},
				},
			}),
		);
		let wire: E2eWire | undefined;
		let sessionId: string | undefined;
		try {
			const workspace = await openWorkspaceChat(page);
			wire = await E2eWire.connect();
			sessionId = (await wire.request("session.list", { workspaceId: workspace.id }))[0]?.sessionId;
			if (!sessionId) throw new Error("The MCP resource probe has no SDK session");
			await send(
				page,
				'This is a bounded MCP resource probe. Call list_mcp_resources with server "fixture" and cursor null. Call list_mcp_resource_templates with server "fixture" and cursor null. Call read_mcp_resource with server "fixture" and uri "fixture://notes/a". Call each once, use no other tools, then reply with the resource text.',
			);
			await waitForAgentSettled(page, 150_000);
			const snapshot = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(snapshot.summary.state?.completion?.outcome).toBe("succeeded");
			for (const name of [
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
			]) {
				const results = snapshot.messages.filter(
					(message) => message.role === "toolResult" && message.toolName === name,
				);
				expect(results).toHaveLength(1);
				const result = results[0];
				if (result?.role !== "toolResult") throw new Error(`Missing ${name} result`);
				expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
				expect(result.details).toMatchObject({ server: "fixture", fullOutput: true });
			}
			const read = snapshot.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "read_mcp_resource",
			);
			if (read?.role !== "toolResult") throw new Error("Missing MCP resource contents");
			expect(JSON.stringify(read.content)).toContain("MCP resource fixture note");
			await expandAllRoutineGroups(page);
			for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
				await expect(
					page.locator(`[data-testid="activity-step"][data-tool="${name}"]`),
				).toHaveAttribute("data-status", "done");
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			const restored = await wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(restored.messages).toEqual(snapshot.messages);
			await testInfo.attach("sdk-mcp-resources", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(snapshot)),
			});
		} finally {
			if (wire && sessionId) await wire.request("session.abort", { sessionId });
			wire?.close();
			rmSync(USER_CONFIG, { force: true });
		}
	},
);

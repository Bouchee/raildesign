import { expect, test } from "bun:test";
import {
	createMcpToolConsent,
	MCP_CONFIRM_ALWAYS,
	MCP_CONFIRM_CHAT,
	MCP_CONFIRM_DENY,
	MCP_CONFIRM_ONCE,
	type McpServerConfig,
	mcpPolicyOf,
	mcpTargetOf,
} from "./mcp";

test("MCP consent keeps deny/once/chat/project scopes and binds persistent grants to the actual target", async () => {
	for (const choice of [MCP_CONFIRM_DENY, MCP_CONFIRM_ONCE, MCP_CONFIRM_CHAT, MCP_CONFIRM_ALWAYS]) {
		let prompts = 0;
		const grants: string[][] = [];
		const config = { command: "fixture", args: ["read"] };
		const consent = createMcpToolConsent({
			policy: () => mcpPolicyOf(undefined),
			askForToolCall: async () => {
				prompts++;
				return choice;
			},
			grantTool: (...grant) => grants.push(grant),
		});
		const call = {
			server: "docs",
			tool: "mcp__docs__write",
			toolCallId: "call",
			input: {},
			config,
			readOnly: false,
			currentConfig: () => config,
		};
		const result = await consent.confirm(call);
		expect(Boolean(result?.block)).toBe(choice === MCP_CONFIRM_DENY);
		await consent.confirm(call);
		expect(prompts).toBe(choice === MCP_CONFIRM_CHAT ? 1 : 2);
		if (choice === MCP_CONFIRM_ALWAYS)
			expect(grants[0]).toEqual(["docs", mcpTargetOf(config), call.tool]);
		if (choice === MCP_CONFIRM_CHAT) {
			const changed = { command: "different" };
			await consent.confirm({ ...call, config: changed, currentConfig: () => changed });
			expect(prompts).toBe(2);
		}
	}
});
test("read-only/persistent allowed tools bypass prompts, while revocation or cancellation during approval blocks the call and grant", async () => {
	const config = { command: "fixture" };
	let current: McpServerConfig | undefined = config;
	let answer!: (value: string) => void;
	let grants = 0;
	const controller = new AbortController();
	const consent = createMcpToolConsent({
		policy: () => mcpPolicyOf(undefined),
		askForToolCall: () =>
			new Promise((resolve) => {
				answer = resolve;
			}),
		grantTool: () => {
			grants++;
		},
	});
	const call = {
		server: "docs",
		tool: "mcp__docs__write",
		toolCallId: "call",
		input: {},
		config,
		readOnly: false,
		currentConfig: () => current,
		signal: controller.signal,
	};
	expect(await consent.confirm({ ...call, readOnly: true })).toBeUndefined();
	const pending = consent.confirm(call);
	current = undefined;
	answer(MCP_CONFIRM_ALWAYS);
	expect(await pending).toMatchObject({ block: true });
	expect(grants).toBe(0);
	current = config;
	const aborted = consent.confirm(call);
	controller.abort();
	answer(MCP_CONFIRM_ONCE);
	expect(await aborted).toMatchObject({ block: true });
});

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

test("MCP consent retains once, chat and project choices with target-bound grants", () => {
	for (const choice of [MCP_CONFIRM_DENY, MCP_CONFIRM_ONCE, MCP_CONFIRM_CHAT, MCP_CONFIRM_ALWAYS]) {
		const grants: string[][] = [];
		const config = { command: "fixture", args: ["read"] };
		const consent = createMcpToolConsent({
			policy: () => mcpPolicyOf(undefined),
			grantTool: (...grant) => grants.push(grant),
		});
		const call = {
			server: "docs",
			tool: "mcp__docs__write",
			config,
			readOnly: false,
			currentConfig: () => config,
		};
		expect(consent.needsApproval(call)).toBe(true);
		expect(consent.applyChoice(call, choice)).toBe(choice !== MCP_CONFIRM_DENY);
		expect(consent.needsApproval(call)).toBe(choice !== MCP_CONFIRM_CHAT);
		if (choice === MCP_CONFIRM_ALWAYS)
			expect(grants).toEqual([["docs", mcpTargetOf(config), call.tool]]);
		if (choice === MCP_CONFIRM_CHAT) {
			expect(consent.needsApproval({ ...call, server: "other" })).toBe(true);
			const changed = { command: "different" };
			expect(
				consent.needsApproval({ ...call, config: changed, currentConfig: () => changed }),
			).toBe(true);
			consent.clear();
			expect(consent.needsApproval(call)).toBe(true);
		}
	}
});

test("read-only and persistent grants bypass approval; revocation and cancellation invalidate a choice", () => {
	const config = { command: "fixture" };
	let current: McpServerConfig | undefined = config;
	let grants = 0;
	const controller = new AbortController();
	const policy = mcpPolicyOf({
		mcpToolGrants: { docs: { target: mcpTargetOf(config), tools: ["mcp__docs__write"] } },
	});
	const consent = createMcpToolConsent({
		policy: () => policy,
		grantTool: () => {
			grants++;
		},
	});
	const call = {
		server: "docs",
		tool: "mcp__docs__write",
		config,
		readOnly: false,
		currentConfig: () => current,
		signal: controller.signal,
	};
	expect(consent.needsApproval({ ...call, readOnly: true })).toBe(false);
	expect(consent.needsApproval(call)).toBe(false);
	delete (policy.toolGrants as Record<string, unknown>).docs;
	expect(consent.needsApproval(call)).toBe(true);
	current = undefined;
	expect(() => consent.applyChoice(call, MCP_CONFIRM_ALWAYS)).toThrow("changed");
	expect(grants).toBe(0);
	current = config;
	controller.abort();
	expect(() => consent.applyChoice(call, MCP_CONFIRM_ONCE)).toThrow("changed");
});

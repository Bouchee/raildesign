import { fingerprintMcpEntry, grantedMcpTools, type McpProjectPolicy, mcpTargetOf } from "./config";
import type { McpServerConfig } from "./types";

export const MCP_CONFIRM_DENY = "Deny";
export const MCP_CONFIRM_ONCE = "Allow once";
export const MCP_CONFIRM_CHAT = "Allow in this chat";
export const MCP_CONFIRM_ALWAYS = "Always allow";
export const MCP_CONFIRM_CHOICES = [
	MCP_CONFIRM_DENY,
	MCP_CONFIRM_ONCE,
	MCP_CONFIRM_CHAT,
	MCP_CONFIRM_ALWAYS,
];
export type GrantMcpTool = (server: string, target: string, tool: string) => void;

export interface McpConsentCall {
	server: string;
	tool: string;
	config: McpServerConfig;
	readOnly: boolean;
	signal?: AbortSignal;
	currentConfig: () => McpServerConfig | undefined;
}

export function createMcpToolConsent(options: {
	policy: () => McpProjectPolicy;
	grantTool: GrantMcpTool;
}) {
	const allowed = new Map<string, string>();
	const key = (call: McpConsentCall) => `${call.server}\0${call.tool}`;
	const assertCurrent = (call: McpConsentCall) => {
		const current = call.currentConfig();
		if (
			!current ||
			current.enabled === false ||
			call.signal?.aborted ||
			mcpTargetOf(current) !== mcpTargetOf(call.config)
		)
			throw new Error("MCP trust or configuration changed before this call");
	};
	return {
		clear(): void {
			allowed.clear();
		},
		needsApproval(call: McpConsentCall): boolean {
			assertCurrent(call);
			return !(
				call.readOnly ||
				allowed.get(key(call)) === fingerprintMcpEntry(call.server, call.config) ||
				grantedMcpTools(options.policy(), call.server, call.config).includes(call.tool)
			);
		},
		applyChoice(call: McpConsentCall, answer: string): boolean {
			assertCurrent(call);
			if (answer === MCP_CONFIRM_ALWAYS) {
				options.grantTool(call.server, mcpTargetOf(call.config), call.tool);
				return true;
			}
			if (answer === MCP_CONFIRM_CHAT) {
				allowed.set(key(call), fingerprintMcpEntry(call.server, call.config));
				return true;
			}
			return answer === MCP_CONFIRM_ONCE;
		},
	};
}

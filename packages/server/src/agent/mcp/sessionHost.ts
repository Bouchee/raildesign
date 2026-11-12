import { grantedMcpTools, type McpProjectPolicy, mcpTargetOf } from "./config";
import type { McpServerConfig } from "./types";

export const MCP_CONFIRM_DENY = "Deny";
export const MCP_CONFIRM_ONCE = "Allow once";
export const MCP_CONFIRM_CHAT = "Allow in this chat";
export const MCP_CONFIRM_ALWAYS = "Always allow";
export type AskForToolCall = (
	toolCallId: string,
	input: Record<string, unknown>,
	title: string,
	options: string[],
	signal: AbortSignal | undefined,
) => Promise<string | undefined>;
export type GrantMcpTool = (server: string, target: string, tool: string) => void;

/** Approval policy is independent of the executor. The SDK tool boundary supplies trusted metadata. */
export function createMcpToolConsent(options: {
	policy: () => McpProjectPolicy;
	askForToolCall: AskForToolCall;
	grantTool: GrantMcpTool;
}) {
	const allowed = new Map<string, string>();
	return {
		clear(): void {
			allowed.clear();
		},
		async confirm(call: {
			server: string;
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			config: McpServerConfig;
			readOnly: boolean;
			signal?: AbortSignal;
			/** Re-read the currently trusted config after the user answers. */
			currentConfig: () => McpServerConfig | undefined;
		}): Promise<{ block: true; reason: string } | undefined> {
			const target = mcpTargetOf(call.config);
			const active = () => {
				const current = call.currentConfig();
				return current !== undefined && !call.signal?.aborted && mcpTargetOf(current) === target;
			};
			if (!active())
				return { block: true, reason: "MCP trust or configuration changed before this call." };
			if (
				call.readOnly ||
				allowed.get(call.tool) === target ||
				grantedMcpTools(options.policy(), call.server, call.config).includes(call.tool)
			)
				return undefined;
			const answer = await options.askForToolCall(
				call.toolCallId,
				call.input,
				`Allow ${call.server}/${call.tool}? It may change data.\nAlways allow trusts this tool in every chat of this project. Manage it in Settings › MCP servers.`,
				[MCP_CONFIRM_DENY, MCP_CONFIRM_ONCE, MCP_CONFIRM_CHAT, MCP_CONFIRM_ALWAYS],
				call.signal,
			);
			if (!active())
				return {
					block: true,
					reason: "MCP trust or configuration changed before this call was confirmed.",
				};
			if (answer === MCP_CONFIRM_ALWAYS) {
				options.grantTool(call.server, target, call.tool);
				return undefined;
			}
			if (answer === MCP_CONFIRM_CHAT) {
				allowed.set(call.tool, target);
				return undefined;
			}
			if (answer === MCP_CONFIRM_ONCE) return undefined;
			return {
				block: true,
				reason:
					answer === MCP_CONFIRM_DENY
						? "The user denied this MCP call."
						: "The user did not confirm this MCP call.",
			};
		},
	};
}

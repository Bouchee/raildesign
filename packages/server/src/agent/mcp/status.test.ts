import { expect, test } from "bun:test";
import type { McpServerStatus, McpServerSummary } from "@thinkrail/contracts";
import { deriveMcpServerStatuses } from "./status";

const summary = (over: Partial<McpServerSummary> & { name: string }): McpServerSummary => ({
	scope: "user",
	source: "/agent/mcp.json",
	fingerprint: "rendered",
	transport: "http",
	endpoint: "https://x",
	exposure: "deferred",
	effectiveExposure: "deferred",
	enabled: true,
	oauth: false,
	...over,
});

test("structured SDK status preserves disable scopes, approval, invalid configuration and the previous snapshot", () => {
	const summaries = [
		summary({ name: "chat-off" }),
		summary({ name: "project-off", projectOverride: { enabled: false } }),
		summary({ name: "repo", scope: "project", approval: { state: "pending", fingerprint: "f" } }),
		summary({ name: "invalid", configError: 'server "invalid" needs either "command" or "url"' }),
	];
	const reported = {
		servers: new Map([
			["chat-off", { state: "disabled" as const, detail: "" }],
			["project-off", { state: "disabled" as const, detail: "" }],
		]),
	};
	const derived = deriveMcpServerStatuses({
		summaries,
		reported,
		disabledInChat: new Set(["chat-off"]),
		previous: [],
		now: 1,
	});
	expect(Object.fromEntries(derived.map((status) => [status.name, status.state]))).toEqual({
		"chat-off": "disabled-in-chat",
		"project-off": "disabled-in-project",
		repo: "pending-approval",
		invalid: "invalid-config",
	});
	const previous: McpServerStatus[] = [
		{ name: "chat-off", state: "connected", toolCount: 3, updatedAt: 1 },
	];
	const stale = deriveMcpServerStatuses({
		summaries: [summary({ name: "chat-off" })],
		reported: null,
		disabledInChat: new Set(),
		previous,
		now: 2,
	});
	expect(stale).toEqual(previous);
});

test("structured SDK failures and configuration diagnostics are redacted before status publication", () => {
	const statuses = deriveMcpServerStatuses({
		summaries: [
			summary({ name: "docs" }),
			summary({ name: "invalid", configError: "API_KEY=private-value" }),
		],
		reported: {
			servers: new Map([
				[
					"docs",
					{
						state: "failed",
						detail: "Authorization: Bearer private-token POST https://ada:pw@api.example/mcp",
					},
				],
			]),
		},
		disabledInChat: new Set(),
		previous: [],
		now: 10,
	});
	expect(statuses[0]?.detail).not.toContain("private-token");
	expect(statuses[0]?.detail).not.toContain("ada:pw");
	expect(statuses[1]?.detail).toBe("API_KEY=***");
});

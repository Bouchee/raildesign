import type { McpServerState, McpServerStatus, McpServerSummary } from "@thinkrail/contracts";
import { redactMcpText } from "./redact";

export interface McpReportedStatus {
	servers: ReadonlyMap<
		string,
		{
			state: McpServerState;
			toolCount?: number;
			detail: string;
		}
	>;
}

export function deriveMcpServerStatuses(options: {
	summaries: readonly McpServerSummary[];
	reported: McpReportedStatus | null;
	disabledInChat: ReadonlySet<string>;
	previous: readonly McpServerStatus[];
	now: number;
}): McpServerStatus[] {
	const { summaries, reported, disabledInChat, previous, now } = options;
	const before = new Map(previous.map((status) => [status.name, status]));
	const names = [
		...new Set([...summaries.map((summary) => summary.name), ...(reported?.servers.keys() ?? [])]),
	];
	return names.map((name): McpServerStatus => {
		const configured = summaries.filter((summary) => summary.name === name);
		const pending = configured.find(
			(summary) => summary.scope === "project" && summary.approval?.state !== "approved",
		);
		const invalid = configured.find((summary) => summary.configError);
		const parsed = reported?.servers.get(name);
		const stamp = (status: Omit<McpServerStatus, "name" | "updatedAt">): McpServerStatus => ({
			name,
			...status,
			updatedAt: now,
		});
		if (parsed?.state === "disabled") {
			if (disabledInChat.has(name))
				return stamp({ state: "disabled-in-chat", detail: redactMcpText(parsed.detail) });
			if (configured.some((summary) => summary.projectOverride?.enabled === false)) {
				return stamp({ state: "disabled-in-project", detail: redactMcpText(parsed.detail) });
			}
			return stamp({ state: "disabled", detail: redactMcpText(parsed.detail) });
		}
		if (parsed) {
			return stamp({
				state: parsed.state,
				...(parsed.toolCount !== undefined ? { toolCount: parsed.toolCount } : {}),
				detail: redactMcpText(parsed.detail),
			});
		}
		if (pending && !configured.some((summary) => summary.scope === "user")) {
			return stamp({ state: "pending-approval" });
		}
		if (invalid)
			return stamp({ state: "invalid-config", detail: redactMcpText(invalid.configError ?? "") });
		if (reported === null) {
			const last = before.get(name);
			return last ? { ...last } : stamp({ state: "unknown" });
		}
		return stamp({ state: "unknown" });
	});
}

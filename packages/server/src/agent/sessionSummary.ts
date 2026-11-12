import type { AgentInputItem } from "@openai/agents";
import type { PersistentSession, SummaryReceipt } from "./sessionStore";

export interface CompactOptions {
	operationId: string;
	force: boolean;
	instructions?: string | undefined;
	tokensBefore?: number | undefined;
	usage?: SummaryReceipt["usage"];
	tokenBudget: number;
	signal: AbortSignal;
	summarize: (prefix: AgentInputItem[], signal: AbortSignal) => Promise<string>;
}

export interface CompactResult {
	status: "compacted" | "skipped" | "replayed";
	beforeTokens: number;
	afterTokens: number;
}

export function estimateSessionTokens(items: readonly AgentInputItem[]): number {
	return Buffer.byteLength(JSON.stringify(items), "utf8");
}

function isUser(item: AgentInputItem | undefined): boolean {
	return item !== undefined && "role" in item && item.role === "user";
}

function completedAssistant(item: AgentInputItem | undefined): boolean {
	return (
		item !== undefined && "role" in item && item.role === "assistant" && item.status === "completed"
	);
}

function assertCompleteFunctionGroups(items: AgentInputItem[]): void {
	const seen = new Set<string>();
	const pending = new Map<string, string>();
	for (const item of items) {
		if (item.type === "function_call") {
			if (!item.callId || seen.has(item.callId)) throw new Error("Duplicate function call ID");
			if (item.status !== undefined && item.status !== "completed")
				throw new Error("Incomplete function call");
			seen.add(item.callId);
			pending.set(item.callId, item.name);
		} else if (item.type === "function_call_result") {
			if (pending.get(item.callId) !== item.name) throw new Error("Unmatched function result");
			// Stop and run errors close interrupted calls as "incomplete"; the pair is still whole.
			if (item.status === "in_progress") throw new Error("Incomplete function result");
			pending.delete(item.callId);
		} else if (item.type !== undefined && item.type !== "message" && item.type !== "reasoning") {
			throw new Error("Summary requires ordinary messages and function tools");
		}
	}
	if (pending.size) throw new Error("Unmatched function call");
}

export async function compactSession(
	store: PersistentSession,
	{
		operationId,
		force,
		instructions = "",
		tokensBefore: measuredTokensBefore,
		usage,
		tokenBudget,
		signal,
		summarize,
	}: CompactOptions,
): Promise<CompactResult> {
	signal.throwIfAborted();
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(operationId))
		throw new Error("Invalid summary operation ID");
	if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
		throw new Error("A verified model token budget is required");
	if (
		measuredTokensBefore !== undefined &&
		(!Number.isSafeInteger(measuredTokensBefore) || measuredTokensBefore < 0)
	)
		throw new Error("Invalid measured token count");
	const original = structuredClone(store.record);
	const previous = Object.hasOwn(original.summaryOperations, operationId)
		? original.summaryOperations[operationId]
		: undefined;
	if (previous) {
		if (previous.force !== force || previous.instructions !== instructions)
			throw new Error("Conflicting summary operation");
		return {
			status: "replayed",
			beforeTokens: previous.beforeTokens,
			afterTokens: previous.afterTokens,
		};
	}
	if (
		original.state.execution !== "idle" ||
		original.state.needsInput ||
		original.pendingApproval ||
		original.pendingToolResponse ||
		original.runCheckpoint
	)
		throw new Error("Summary requires a settled run without a resumable checkpoint");
	const beforeTokens = estimateSessionTokens(original.history);
	const skipped: CompactResult = { status: "skipped", beforeTokens, afterTokens: beforeTokens };
	if (!force && beforeTokens < Math.floor(tokenBudget * 0.75)) return skipped;
	let split = original.history.length - 2;
	while (split >= 0 && !isUser(original.history[split])) split -= 1;
	if (split <= 0) return skipped;
	const prefix = original.history.slice(0, split);
	const recent = original.history.slice(split);
	assertCompleteFunctionGroups(prefix);
	assertCompleteFunctionGroups(recent);
	if (!prefix.some(isUser) || !completedAssistant(prefix.at(-1))) return skipped;
	if (!completedAssistant(recent.at(-1))) throw new Error("Summary requires completed exchanges");
	const summary = await summarize(structuredClone(prefix), signal);
	signal.throwIfAborted();
	if (
		typeof summary !== "string" ||
		!summary.trim() ||
		Buffer.byteLength(summary, "utf8") > Math.min(8192, Math.floor(tokenBudget / 4))
	)
		throw new Error("Summary must be nonempty and within the model summary budget");
	const history: AgentInputItem[] = [
		{
			type: "message",
			role: "user",
			id: `summary_${operationId}`,
			content: `Earlier conversation summary:\n${summary.trim()}`,
		},
		...recent,
	];
	const afterTokens = estimateSessionTokens(history);
	if (afterTokens >= beforeTokens) throw new Error("Summary did not reduce model history");
	const receipt: SummaryReceipt = {
		force,
		instructions,
		sourceRevision: original.revision,
		beforeTokens,
		afterTokens,
		...(usage ? { usage: structuredClone(usage) } : {}),
	};
	store.update((record) => {
		signal.throwIfAborted();
		record.history = history;
		record.retiredInputIds = [
			...new Set([
				...record.retiredInputIds,
				...prefix.flatMap((item) =>
					"role" in item && item.role === "user" && item.id ? [item.id] : [],
				),
			]),
		];
		record.summaryOperations = { ...record.summaryOperations, [operationId]: receipt };
		if (measuredTokensBefore !== undefined)
			record.messages.push({
				id: `summary:${operationId}`,
				role: "compactionSummary",
				summary: summary.trim(),
				tokensBefore: measuredTokensBefore,
				timestamp: Date.now(),
			});
		delete record.modelContextTokens;
	}, original.revision);
	return { status: "compacted", beforeTokens, afterTokens };
}

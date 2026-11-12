import type { Usage } from "@thinkrail/contracts";

export const SUBAGENT_USAGE_KIND = "subagent";

const COST_EPSILON = 1e-9;

export interface SubagentUsage {
	childSessionId: string;
	provider: string;
	model: string;
	usage: Usage;
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function toUsage({ input, output, cacheRead, cacheWrite, cost }: Totals): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function tokensOf(totals: Totals): number {
	return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function subagentUsage(
	childSessionId: string,
	modelRef: string | undefined,
	totals: Totals,
): SubagentUsage {
	const ref = modelRef ?? "unknown";
	const slash = ref.indexOf("/");
	return {
		childSessionId,
		provider: slash > 0 ? ref.slice(0, slash) : "unknown",
		model: ref.slice(slash + 1),
		usage: toUsage(totals),
	};
}

function usageIncrement(current: Totals, watermark: Totals | undefined): Totals | undefined {
	const base = watermark ?? emptyTotals();
	const cost = current.cost - base.cost;
	const increment: Totals = {
		input: Math.max(0, current.input - base.input),
		output: Math.max(0, current.output - base.output),
		cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
		cost: cost > COST_EPSILON ? cost : 0,
	};
	return tokensOf(increment) > 0 || increment.cost > 0 ? increment : undefined;
}

function raiseWatermark(watermark: Totals | undefined, current: Totals): Totals {
	const base = watermark ?? emptyTotals();
	return {
		input: Math.max(base.input, current.input),
		output: Math.max(base.output, current.output),
		cacheRead: Math.max(base.cacheRead, current.cacheRead),
		cacheWrite: Math.max(base.cacheWrite, current.cacheWrite),
		cost: Math.max(base.cost, current.cost),
	};
}

export interface RunUsageDetails {
	model?: string;
	usage: Totals;
}

export function createRunUsageRecorder(
	record: (parentSessionId: string, usage: SubagentUsage) => boolean,
) {
	const watermarks = new Map<string, Totals>();
	const progress = (parentSessionId: string, childSessionId: string, details: RunUsageDetails) => {
		const watermark = watermarks.get(childSessionId);
		const increment = usageIncrement(details.usage, watermark);
		if (!increment) return;
		if (record(parentSessionId, subagentUsage(childSessionId, details.model, increment)))
			watermarks.set(childSessionId, raiseWatermark(watermark, details.usage));
	};
	return {
		progress,
		terminal: (parentSessionId: string, childSessionId: string, details: RunUsageDetails) => {
			progress(parentSessionId, childSessionId, details);
			watermarks.delete(childSessionId);
		},
	};
}

function emptyTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function unrecordedUsage(
	total: SubagentUsage,
	recorded: Totals | undefined,
): SubagentUsage | undefined {
	const base = recorded ?? emptyTotals();
	const missing: Totals = {
		input: total.usage.input - base.input,
		output: total.usage.output - base.output,
		cacheRead: total.usage.cacheRead - base.cacheRead,
		cacheWrite: total.usage.cacheWrite - base.cacheWrite,
		cost: total.usage.cost.total - base.cost,
	};
	const tokens = [missing.input, missing.output, missing.cacheRead, missing.cacheWrite];
	if (tokens.some((count) => count < 0)) return undefined;
	if (missing.cost <= COST_EPSILON) missing.cost = 0;
	if (tokensOf(missing) === 0 && missing.cost === 0) return undefined;
	return { ...total, usage: toUsage(missing) };
}

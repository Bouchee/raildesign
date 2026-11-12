import { expect, test } from "bun:test";
import { createRunUsageRecorder, unrecordedUsage } from "./subagentUsage";

function recorderHarness(outcomes: boolean[] = []) {
	const writes: { input: number; cost: number }[] = [];
	const recorder = createRunUsageRecorder((_parent, { usage }) => {
		writes.push({ input: usage.input, cost: usage.cost.total });
		return outcomes.shift() ?? true;
	});
	const run = (input: number, cost: number) => ({
		model: "anthropic/claude",
		usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost },
	});
	return { writes, recorder, run };
}

test("a run records each increment once and its remainder at the end, cost-only included", () => {
	const { writes, recorder, run } = recorderHarness();
	recorder.progress("parent", "child", run(10, 0.1));
	recorder.progress("parent", "child", run(10, 0.1));
	recorder.progress("parent", "child", run(10, 0.1 + 1e-12));
	recorder.progress("parent", "child", run(25, 0.2));
	recorder.terminal("parent", "child", run(25, 0.5));
	expect(writes.map(({ input }) => input)).toEqual([10, 15, 0]);
	expect(writes.map(({ cost }) => cost).reduce((sum, cost) => sum + cost)).toBeCloseTo(0.5, 12);
	expect(writes[2]?.cost).toBeCloseTo(0.3, 12);
});

test("an increment the application did not take is carried within the run but not into the next run", () => {
	const { writes, recorder, run } = recorderHarness([false, true, false]);
	recorder.progress("parent", "child", run(10, 0));
	recorder.terminal("parent", "child", run(30, 0));
	expect(writes.map(({ input }) => input)).toEqual([10, 30]);

	recorder.terminal("parent", "child", run(5, 0));
	recorder.terminal("parent", "child", run(7, 0));
	expect(writes.map(({ input }) => input)).toEqual([10, 30, 5, 7]);
});

test("reconciliation computes only a non-negative shortfall and ignores floating cost noise", () => {
	const total = {
		childSessionId: "child",
		provider: "test",
		model: "test",
		usage: {
			input: 30,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 31,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
	};
	const recorded = (input: number, cost: number) => ({
		input,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost,
	});
	expect(unrecordedUsage(total, undefined)?.usage.input).toBe(30);
	expect(unrecordedUsage(total, recorded(10, 0.1))?.usage.input).toBe(20);
	expect(unrecordedUsage(total, recorded(30, 0.3 - 1e-12))).toBeUndefined();
	expect(unrecordedUsage(total, recorded(30, 0.25))?.usage).toMatchObject({
		input: 0,
		output: 0,
		totalTokens: 0,
	});
	expect(unrecordedUsage(total, recorded(30, 0.25))?.usage.cost.total).toBeCloseTo(0.05, 12);
	expect(unrecordedUsage(total, recorded(40, 0.4))).toBeUndefined();
});

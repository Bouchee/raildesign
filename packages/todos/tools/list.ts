import { tool } from "@openai/agents";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@thinkrail/shared/toolOutput";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { countItems, flatItems, TODO_STATUSES, type TodoPlan } from "../core/index.ts";
import type { TodoToolServices } from "./shared.ts";
import {
	consistencyNudge,
	errorResult,
	formatPlan,
	formatTodo,
	storeFor,
	stringEnum,
	textResult,
	withNudges,
} from "./shared.ts";

const MAX_PAGE_LINES = DEFAULT_MAX_LINES - 10;

const parameters = Type.Object({
	status: Type.Optional(
		stringEnum(TODO_STATUSES, {
			description:
				"Filter to one status: pending | in_progress | done (flat across groups). Omit for the whole plan.",
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Zero-based rendered-line offset (default: 0). Continue with the offset given in the result and the same status filter; restart after plan edits.",
		}),
	),
});

export function createTodoList(services: TodoToolServices) {
	return tool({
		name: "todo_list",
		description:
			"Read this chat's TODO plan — loose items plus named groups (optionally filtered by status). The plan is the source of truth and the user may edit it at any time, so re-read before choosing each next item, after user input, and before completion. A plan beyond the 2,000-line / 50 KiB output limit continues at the offset given in the result; oversized text is saved to a temporary file.",
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const offset = params.offset ?? 0;
			if (!Number.isSafeInteger(offset) || offset < 0)
				return errorResult("Use a nonnegative integer offset.");
			const plan = storeFor(services).read();
			const filtered: TodoPlan = params.status
				? {
						todos: plan.todos.filter((todo) => todo.status === params.status),
						groups: plan.groups
							.map((group) => ({
								...group,
								todos: group.todos.filter((todo) => todo.status === params.status),
							}))
							.filter((group) => group.todos.length > 0),
					}
				: plan;
			const items = flatItems(filtered);
			const rendered = params.status
				? items.length
					? items.map(formatTodo).join("\n")
					: `No ${params.status} TODOs.`
				: countItems(plan)
					? withNudges(formatPlan(plan), consistencyNudge(plan))
					: "The plan is empty.";
			const lines = rendered.split("\n");
			if (offset >= lines.length)
				return textResult("No more plan lines. Restart at offset: 0 if the plan changed.", {
					plan: filtered,
				});
			const candidate = lines.slice(offset, offset + MAX_PAGE_LINES).join("\n");
			const page = truncateHead(candidate, {
				maxBytes: DEFAULT_MAX_BYTES - 2048,
				maxLines: MAX_PAGE_LINES,
			});
			const count = page.firstLineExceedsLimit ? 1 : page.outputLines;
			const body = page.firstLineExceedsLimit ? (lines[offset] ?? "") : page.content;
			const nextOffset = offset + count < lines.length ? offset + count : undefined;
			const continuation =
				nextOffset === undefined
					? ""
					: `More plan lines: call todo_list with offset: ${nextOffset}${params.status ? ` and status: ${params.status}` : ""}. Restart at offset: 0 after plan edits.`;
			return textResult(
				body,
				{ plan: filtered, ...(nextOffset === undefined ? {} : { nextOffset }) },
				continuation,
			);
		},
	});
}

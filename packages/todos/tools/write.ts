import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { countItems, TODO_STATUSES, type WritePlan } from "../core/index.ts";
import type { TodoToolServices } from "./shared.ts";
import {
	consistencyNudge,
	formatPlan,
	storeFor,
	stringEnum,
	textResult,
	withNudges,
} from "./shared.ts";

const item = Type.Object({
	title: Type.String({
		description:
			'The step\'s one-line title: imperative and about the change/outcome, short and scannable — not the process ("make a plan", "read the files") and not agent bookkeeping (that goes in note).',
	}),
	status: Type.Optional(
		stringEnum(TODO_STATUSES, { description: "Initial status (defaults to pending)." }),
	),
	note: Type.Optional(Type.String({ description: "A short secondary line." })),
});

const group = Type.Object({
	title: Type.String({
		description: 'The task\'s short name — an outcome ("Fix login redirect"), not a process.',
	}),
	todos: Type.Array(item, { description: "The task's ordered steps." }),
});

const parameters = Type.Object({
	groups: Type.Array(group, {
		description:
			"The plan as tasks: one group per user ask (title = the outcome), each carrying its ordered steps. Use a 1–2-step group only when the user explicitly asked for a plan; otherwise plans start at three substantive steps. Loose items are the shared raw-input queue — todo_write never touches them.",
	}),
});

export function createTodoWrite(services: TodoToolServices) {
	return tool({
		name: "todo_write",
		description:
			"Lay out or reconcile the plan as these groups — one group per task (a user ask; title = the outcome), each with its ordered steps. This RECONCILES, it does not destructively replace: written steps are matched to existing ones by group title + step title and keep their status/summary/id, so re-running it is safe and lossless (a re-listed in-progress or done step is NOT reset — status advances only via todo_update, and a status you pass here for an existing step is ignored). Unmatched written steps are created; your steps you omit are dropped; loose items and completed (done) items are always preserved. Keep step titles stable across a re-plan — a reworded title reads as a new step. For a single change prefer todo_add/todo_update (cheaper than restating the whole plan).",
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const write: WritePlan = { groups: params.groups };
			const plan = storeFor(services).replaceAll(write);
			const count = countItems(plan);
			const text = count
				? withNudges(
						`Wrote the plan (${count} item(s) total):\n${formatPlan(plan)}`,
						consistencyNudge(plan),
					)
				: "Cleared the plan.";
			return textResult(text, { plan });
		},
	});
}

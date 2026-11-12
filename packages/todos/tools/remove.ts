import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TodoToolServices } from "./shared.ts";
import { errorResult, storeFor, textResult } from "./shared.ts";

const parameters = Type.Object({
	id: Type.String({ description: "Id of the item to remove." }),
});

export function createTodoRemove(services: TodoToolServices) {
	return tool({
		name: "todo_remove",
		description:
			"Delete an item from the list by id. Rarely needed: a finished item is marked done (todo_update), not removed — done items stay as the user's history. Remove only when the user explicitly asks to drop an item; to take a loose item into work, use todo_promote.",
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const removed = storeFor(services).remove(params.id);
			if (!removed) return errorResult(`No TODO with id "${params.id}".`);
			return textResult(`Removed ${params.id}.`, { id: params.id });
		},
	});
}

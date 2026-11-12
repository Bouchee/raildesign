import { createTodoAdd } from "./add.ts";
import { createTodoList } from "./list.ts";
import { createTodoPlanSummary } from "./planSummary.ts";
import { createTodoPromote } from "./promote.ts";
import { createTodoRemove } from "./remove.ts";
import type { TodoToolServices } from "./shared.ts";
import { createTodoUpdate } from "./update.ts";
import { createTodoWrite } from "./write.ts";

export function createTodoTools(services: TodoToolServices) {
	return [
		createTodoList(services),
		createTodoAdd(services),
		createTodoUpdate(services),
		createTodoPromote(services),
		createTodoRemove(services),
		createTodoWrite(services),
		createTodoPlanSummary(services),
	];
}

export type { TodoToolServices } from "./shared.ts";

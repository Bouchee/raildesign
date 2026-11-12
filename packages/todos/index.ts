export { createTodoTools, type TodoToolServices } from "./tools/index.ts";

export const TODO_RULE = [
	"This chat has a shared TODO list — your live plan for the conversation, which the user edits too.",
	"A pending loose item already in that list is promoted into its own group when you take it into work, regardless of size.",
	"When the user asks for a plan or new work needs at least three substantive execution steps, read the todos skill, create a concise plan once the task is understood enough to plan, and keep it current.",
].join("\n");

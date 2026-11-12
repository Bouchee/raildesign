import { createSpecCreate } from "./create.ts";
import { createSpecDelete } from "./delete.ts";
import { createSpecGet } from "./get.ts";
import { createSpecGraph } from "./graph.ts";
import { createSpecGrep } from "./grep.ts";
import { createSpecSearch } from "./search.ts";
import type { SpecToolServices } from "./shared.ts";
import { createSpecUpdate } from "./update.ts";
import { createSpecValidate } from "./validate.ts";

export function createSpecTools(services: SpecToolServices) {
	return [
		createSpecGrep(services),
		createSpecSearch(services),
		createSpecGet(services),
		createSpecGraph(services),
		createSpecCreate(services),
		createSpecUpdate(services),
		createSpecDelete(services),
		createSpecValidate(services),
	];
}

export type { SpecToolServices } from "./shared.ts";

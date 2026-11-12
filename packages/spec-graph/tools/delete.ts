import { rmSync } from "node:fs";
import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SpecToolServices } from "./shared.ts";
import { errorResult, getIndex, textResult } from "./shared.ts";

const parameters = Type.Object({
	id: Type.String({ description: "Id of the spec to delete." }),
});

export function createSpecDelete(services: SpecToolServices) {
	return tool({
		name: "spec_delete",
		description:
			"Delete a spec file by id. Other specs may still reference it afterward — run spec_validate to find dangling links.",
		needsApproval: true,
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const index = getIndex(services.cwd);
			const path = index.pathForId(params.id);
			if (!path) return errorResult(`No spec with id "${params.id}".`);
			try {
				rmSync(index.absPath(path));
			} catch (err) {
				return errorResult(`Failed to delete ${path}: ${(err as Error).message}`);
			}
			return textResult(`Deleted ${path} (id: ${params.id}).`, { id: params.id, path });
		},
	});
}

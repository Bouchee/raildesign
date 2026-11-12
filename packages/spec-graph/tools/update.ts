import { writeFileSync } from "node:fs";
import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { FIELDS, type FrontmatterEdit, updateFrontmatterText } from "../core/index.ts";
import type { SpecToolServices } from "./shared.ts";
import { errorResult, getIndex, textResult, toolError } from "./shared.ts";

const listGroup = Type.Object({
	[FIELDS.dependsOn]: Type.Optional(Type.Array(Type.String())),
	[FIELDS.references]: Type.Optional(Type.Array(Type.String())),
	[FIELDS.implements]: Type.Optional(Type.Array(Type.String())),
	[FIELDS.covers]: Type.Optional(Type.Array(Type.String())),
	[FIELDS.tags]: Type.Optional(Type.Array(Type.String())),
});

const parameters = Type.Object({
	id: Type.String({ description: "Id of the spec to update." }),
	set: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Scalar frontmatter fields to set/overwrite (e.g. title, status, parent). For list fields (depends-on/references/implements/covers/tags) use addList/removeList.",
		}),
	),
	remove: Type.Optional(
		Type.Array(Type.String(), { description: "Frontmatter field names to remove entirely." }),
	),
	addList: Type.Optional(listGroup),
	removeList: Type.Optional(listGroup),
});

export function createSpecUpdate(services: SpecToolServices) {
	return tool({
		name: "spec_update",
		description:
			"Edit a spec's frontmatter only (never its prose): set/overwrite scalar fields, remove fields, and add/remove entries in the list fields (depends-on/references/implements/covers/tags). Comments and any non-dialect fields are preserved. Prose is edited with the write/edit tools.",
		needsApproval: true,
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: (_context, error, details) =>
			toolError(services, error, details?.toolCall?.callId),
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const index = getIndex(services.cwd);
			const record = index.recordForId(params.id);
			if (!record) return errorResult(`No spec with id "${params.id}".`);

			const { abs, rel: path, content: cachedText } = record;
			const edit: FrontmatterEdit = {
				set: params.set,
				remove: params.remove,
				addList: params.addList,
				removeList: params.removeList,
			};
			const result = updateFrontmatterText(cachedText, edit);
			if ("error" in result) return errorResult(result.error);
			try {
				writeFileSync(abs, result.content, "utf8");
			} catch (err) {
				return errorResult(`Failed to write ${path}: ${(err as Error).message}`);
			}
			return textResult(`Updated frontmatter of ${path} (id: ${params.id}).`, {
				id: params.id,
				path,
			});
		},
	});
}

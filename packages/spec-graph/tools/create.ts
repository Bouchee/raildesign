import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	FIELDS,
	type Frontmatter,
	isSpec,
	parseFile,
	resolveSpecPath,
	SPEC_STATUSES,
	SPEC_TYPES,
	serializeFrontmatter,
} from "../core/index.ts";
import type { SpecToolServices } from "./shared.ts";
import { errorResult, getIndex, scaffoldBody, stringEnum, textResult } from "./shared.ts";

const parameters = Type.Object({
	path: Type.String({
		description:
			"Root-relative path for the new spec file, ending in .md (e.g. src/foo/SPEC.md). Must stay inside the project root.",
	}),
	id: Type.String({ description: "Unique spec id." }),
	type: stringEnum(SPEC_TYPES, {
		description:
			"Spec type: goal-and-requirements | architecture-design | module-design | submodule-design | task-spec.",
	}),
	title: Type.String({ description: "Human-readable title." }),
	status: Type.Optional(
		stringEnum(SPEC_STATUSES, {
			description: "Lifecycle status: draft | active | stale | done | deprecated.",
		}),
	),
	parent: Type.Optional(Type.String({ description: "Parent id (the tree edge)." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "depends-on link ids." })),
	references: Type.Optional(Type.Array(Type.String(), { description: "references link ids." })),
	implements: Type.Optional(Type.Array(Type.String(), { description: "implements link ids." })),
	covers: Type.Optional(Type.Array(Type.String(), { description: "covers ids." })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "tags." })),
});

export function createSpecCreate(services: SpecToolServices) {
	return tool({
		name: "spec_create",
		description:
			"Create a new spec file with scaffolded frontmatter (id, type, title, an optional status, and any links) and a heading-only body stub chosen by type. Fails if the file already exists, the id is already in use, or the path is not an indexable root-relative .md path. Edit prose afterward with the write/edit tools.",
		needsApproval: true,
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const resolved = resolveSpecPath(services.cwd, params.path);
			if ("error" in resolved) return errorResult(resolved.error);
			const { rel, abs } = resolved;

			const index = getIndex(services.cwd);
			if (existsSync(abs)) return errorResult(`File already exists: ${rel}`);
			if (index.graph().nodes.has(params.id)) {
				return errorResult(`Spec id "${params.id}" is already in use.`);
			}

			const fm: Frontmatter = { [FIELDS.id]: params.id, [FIELDS.type]: params.type };
			if (params.status !== undefined) fm[FIELDS.status] = params.status;
			fm[FIELDS.title] = params.title;
			if (params.parent !== undefined) fm[FIELDS.parent] = params.parent;
			if (params.dependsOn?.length) fm[FIELDS.dependsOn] = params.dependsOn;
			if (params.references?.length) fm[FIELDS.references] = params.references;
			if (params.implements?.length) fm[FIELDS.implements] = params.implements;
			if (params.covers?.length) fm[FIELDS.covers] = params.covers;
			if (params.tags?.length) fm[FIELDS.tags] = params.tags;

			const content = `${serializeFrontmatter(fm)}\n${scaffoldBody(params.type)}`;
			if (!isSpec(parseFile(content).frontmatter)) {
				return errorResult(
					`Refusing to write ${rel}: the frontmatter would not be a spec (id and type must be non-empty).`,
				);
			}
			try {
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content, { encoding: "utf8", flag: "wx" });
			} catch (err) {
				return errorResult(`Failed to write ${rel}: ${(err as Error).message}`);
			}
			return textResult(`Created ${rel} (id: ${params.id}).`, { path: rel, id: params.id });
		},
	});
}

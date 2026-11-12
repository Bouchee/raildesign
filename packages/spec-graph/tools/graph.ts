import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { graphSlice, LINK_KINDS, SLICE_DIRECTIONS } from "../core/index.ts";
import type { SpecToolServices } from "./shared.ts";
import { errorResult, getIndex, stringEnum, textResult } from "./shared.ts";

const parameters = Type.Object({
	root: Type.String({ description: "Id of the node to start from." }),
	direction: stringEnum(SLICE_DIRECTIONS, {
		description:
			"subtree = down the parent tree; ancestors = up the parent chain; neighbors = across an edge and its reverse.",
	}),
	depth: Type.Optional(Type.Number({ description: "How many hops to expand (default: 1)." })),
	edge: Type.Optional(
		stringEnum(LINK_KINDS, {
			description: "For direction=neighbors: which edge kind to traverse (default: depends-on).",
		}),
	),
});

export function createSpecGraph(services: SpecToolServices) {
	return tool({
		name: "spec_graph",
		description:
			"Return a bounded slice of the spec-graph rooted at a node: `subtree` (down the parent tree), `ancestors` (up to the tree root), or `neighbors` (across a chosen edge and its reverse). Bounded by `depth` (default 1).",
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: null,
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const graph = getIndex(services.cwd).graph();
			if (!graph.nodes.has(params.root)) {
				return errorResult(`No spec with id "${params.root}".`);
			}
			const slice = graphSlice(graph, {
				root: params.root,
				direction: params.direction,
				...(params.depth !== undefined ? { depth: params.depth } : {}),
				...(params.edge !== undefined ? { edge: params.edge } : {}),
			});

			const nodeLines = slice.nodes.map(
				(n) => `  ${n.id} [${n.type}]${n.title ? ` — ${n.title}` : ""} (${n.path})`,
			);
			const edgeLines = slice.edges.map((e) => `  ${e.from} --${e.kind}--> ${e.to}`);
			const text = [
				`Slice of "${params.root}" (${params.direction}, depth ${params.depth ?? 1}):`,
				`nodes (${slice.nodes.length}):`,
				...nodeLines,
				`edges (${slice.edges.length}):`,
				...edgeLines,
				slice.missing.length ? `missing targets: ${slice.missing.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n");

			return textResult(text, slice);
		},
	});
}

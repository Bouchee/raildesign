import { tool } from "@openai/agents";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type Frontmatter, LINK_KINDS, type LinkKind, linkTargets } from "../core/index.ts";
import type { SpecToolServices } from "./shared.ts";
import { errorResult, getIndex, textResult, toolError } from "./shared.ts";

const parameters = Type.Object({
	id: Type.String({ description: "The spec id to look up." }),
});

interface ResolvedLink {
	kind: LinkKind;
	target: string;
	path: string | null;
}

interface GetDetails {
	id: string;
	type: string;
	title: string | undefined;
	path: string;
	frontmatter: Frontmatter;
	links: ResolvedLink[];
	reverseLinks: ResolvedLink[];
}

export function createSpecGet(services: SpecToolServices) {
	return tool({
		name: "spec_get",
		description:
			"Get one spec node by id: its frontmatter, path, and resolved links (forward + reverse edges across parent/depends-on/references/implements). Returns no prose body — read the file at the returned path with the read tool.",
		strict: false,
		parameters: { ...parameters, required: parameters.required ?? [], additionalProperties: true },
		errorFunction: (_context, error, details) =>
			toolError(services, error, details?.toolCall?.callId),
		async execute(params) {
			services.assertActive();
			if (!Value.Check(parameters, params)) throw new Error("Invalid tool arguments");
			const graph = getIndex(services.cwd).graph();
			const node = graph.nodes.get(params.id);
			if (!node) return errorResult(`No spec with id "${params.id}".`);

			const links: ResolvedLink[] = [];
			for (const kind of LINK_KINDS) {
				for (const target of linkTargets(node.frontmatter, kind)) {
					links.push({ kind, target, path: graph.nodes.get(target)?.path ?? null });
				}
			}
			const reverseLinks: ResolvedLink[] = [];
			for (const kind of LINK_KINDS) {
				for (const source of graph.reverse[kind].get(params.id) ?? []) {
					reverseLinks.push({ kind, target: source, path: graph.nodes.get(source)?.path ?? null });
				}
			}

			const details: GetDetails = {
				id: node.id,
				type: node.type,
				title: node.title,
				path: node.path,
				frontmatter: node.frontmatter,
				links,
				reverseLinks,
			};

			const fmtLink = (l: ResolvedLink) =>
				`  ${l.kind} -> ${l.target}${l.path ? ` (${l.path})` : " (missing)"}`;
			const text = [
				`${node.id} [${node.type}]${node.title ? ` — ${node.title}` : ""}`,
				`path: ${node.path}`,
				links.length ? `links:\n${links.map(fmtLink).join("\n")}` : "links: (none)",
				reverseLinks.length
					? `referenced by:\n${reverseLinks.map(fmtLink).join("\n")}`
					: "referenced by: (none)",
			].join("\n");

			return textResult(text, details);
		},
	});
}

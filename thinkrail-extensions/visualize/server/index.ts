import { tool } from "@openai/agents";
import { defineServerExtension } from "@thinkrail/extension-api/server";
import {
	comparisonMarkdown,
	fileMarkdown,
	fileSources,
	mermaidFence,
	mermaidSources,
	VisualizeSchema,
	validateShape,
} from "@thinkrail/visualize";
import { Value } from "typebox/value";
import { strictMermaidValidator } from "./mermaid";

export default defineServerExtension({
	name: "visualize",
	title: "Visualize",
	description:
		"Lets the agent draw Mermaid diagrams, side-by-side option comparisons, and rendered file previews or before/after mockups in chat.",
	sdkTools: (session) => [
		tool({
			name: "visualize",
			description: `Show a rich visualization. Use type 'diagram' with raw Mermaid source, 'comparison' with named options and pros/cons, or 'file' with an existing workspace-relative path. Set 'before' to another file for a before/after comparison. For UI proposals, write self-contained HTML mockups under \`${session.workspaceFiles.scratchDir}\` with inline CSS and data images only. Draw controls as styled elements. File previews use the current file contents; copy a file to preserve an earlier proposal.`,
			strict: false,
			parameters: {
				...VisualizeSchema,
				required: VisualizeSchema.required ?? [],
				additionalProperties: true,
			},
			errorFunction: (_context, error, details) => {
				if (details?.toolCall) session.markToolFailed(details.toolCall.callId);
				return JSON.stringify({
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				});
			},
			async execute(params) {
				session.assertActive();
				if (!Value.Check(VisualizeSchema, params))
					throw new Error("Invalid visualization arguments");
				validateShape(params);
				for (const { location, source } of mermaidSources(params)) {
					try {
						await strictMermaidValidator(source);
					} catch (error) {
						throw new Error(
							`visualize: invalid Mermaid syntax in \`${location}\`: ${error instanceof Error ? error.message : String(error)}\nCorrect the syntax and call \`visualize\` again.`,
						);
					}
				}
				for (const { location, path } of fileSources(params)) {
					try {
						await session.workspaceFiles.check(path, session.cwd);
					} catch (error) {
						throw new Error(
							`visualize: cannot show \`${location}\` (${path}): ${error instanceof Error ? error.message : String(error)}\nWrite the file first, then call \`visualize\` again.`,
						);
					}
				}
				session.assertActive();
				const text =
					params.type === "diagram"
						? mermaidFence(params.title, params.mermaid ?? "")
						: params.type === "file"
							? fileMarkdown(params)
							: comparisonMarkdown(params.title, params.options ?? []);
				return { content: [{ type: "text", text }], details: params };
			},
		}),
	],
});

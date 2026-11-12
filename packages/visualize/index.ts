export { comparisonMarkdown, fileMarkdown, mermaidFence } from "./src/markdown.ts";
export { type ComparisonOption, type VisualizeParams, VisualizeSchema } from "./src/schema.ts";
export { fileSources, mermaidSources, validateShape } from "./src/validate.ts";
export type MermaidValidator = (source: string) => void | Promise<void>;

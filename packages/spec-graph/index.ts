export { createSpecTools, type SpecToolServices } from "./tools/index.ts";

export const SPEC_RULE = [
	"Specs are this project's ground truth.",
	"- Consult the relevant spec when work is governed by or may alter a documented boundary, contract, invariant, behavior, or architecture decision; localized work need not read unrelated specs.",
	"- spec_search finds the governing sections by words; spec_grep matches an exact pattern.",
	"- Treat applicable decisions and contracts as authoritative; reconcile contradictions instead of diverging.",
	"- When a change alters a boundary, contract, invariant, or decision, update the owning spec as part of that change.",
].join("\n");

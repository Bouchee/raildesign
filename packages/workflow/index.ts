export const WORKFLOW_RULE = [
	"At the start of a new piece of work, read the choosing-a-workflow skill before any other tool call for project onboarding, PR lifecycle work (including checking a PR's CI), or any change to what the product does — a feature, a behavior change, or a bug fix, however small.",
	"Non-PR questions, explanations, and checks, and edits that change no behavior (typos, documentation or configuration only, mechanical refactors), proceed directly without loading or announcing a workflow.",
	"For direct questions about source files and fully specified local mechanical edits, when no Spec, TODO/Plan, or documented architecture/contract work is involved, inspect the relevant files directly without calling spec_* or todo_* tools.",
	"Continue work already routed to a workflow without routing it again; if that workflow's skill text is no longer in your context, read its SKILL.md again before the next step.",
].join("\n");

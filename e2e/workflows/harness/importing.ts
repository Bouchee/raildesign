import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type AskUserQuestionResult,
	isAskUserQuestionArgs,
	isAskUserQuestionResult,
} from "@thinkrail/ask-user-question/core";
import { isValid, parseFile, SpecIndex, scalar, validateGraph } from "@thinkrail/spec-graph/core";
import { checks } from "./checks";
import type { CapturedToolCall, EventLog } from "./events";

const INPUT_FILES = {
	"AGENTS.md": [
		"# acme-widgets",
		"",
		"acme-widgets is a small command-line tool that batch-resizes images.",
		"",
		"## Modules",
		"- `src/cli` — argument parsing and the command entry point.",
		"- `src/resize` — the image-resizing pipeline (the core logic).",
		"",
		"`cli` calls `resize`; `resize` never imports `cli`.",
		"",
	].join("\n"),
	"README.md": "# acme-widgets\n\nBatch-resize images from the command line.\n",
	"CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- Extracted the resize module.\n",
	"src/cli/index.ts":
		'import { resize } from "../resize";\n\nexport function main(argv: string[]): void {\n\tresize(argv);\n}\n',
	"src/resize/index.ts":
		"// The core domain. Never imports from cli.\nexport function resize(files: string[]): void {\n\tvoid files;\n}\n",
};
const DURABLE_DOCS = {
	"docs/architecture.md": [
		"# Architecture",
		"",
		"acme-widgets is two modules with a one-way edge.",
		"",
		"- `src/cli` — argument parsing and the command entry point; the only module that talks to the user.",
		"- `src/resize` — the image-resizing pipeline (the core domain).",
		"",
		"`cli` depends on `resize`. `resize` never imports `cli`.",
		"",
		"The resize pipeline is pure: no filesystem access inside `src/resize`; the CLI owns all I/O.",
		"",
	].join("\n"),
	"docs/adr/0001-pure-resize-pipeline.md": [
		"# ADR 0001 — the resize pipeline stays pure",
		"",
		"Status: accepted.",
		"",
		"All filesystem access lives in `src/cli`; `src/resize` transforms buffers only. This keeps the",
		"pipeline unit-testable without fixtures.",
		"",
	].join("\n"),
};
const PLAN =
	"# Phase 2 rollout plan\n\nStatus: completed 2026-05.\n\n- [x] Extract resize() into src/resize\n- [x] Wire CLI flags\n- [x] Ship v0.2\n";
const TODO = "# TODO\n\n- [ ] add --verbose flag\n";
const MAINTAINER_INTENT =
	"A CLI that batch-resizes images. Keep the existing module boundaries and one-way dependency. " +
	"The pure resize pipeline is intended to be testable without filesystem fixtures. " +
	"Existing durable docs state the intended boundary; the skeletal implementation is incomplete. " +
	"Preserve the original durable prose. Record actual implementation gaps as unconfirmed only in new " +
	"draft Specs, without implementing them. Do not add requirements or non-goals.";

export type ImportChoice = "accept" | "decline" | "no-docs";

export function seedImportWorkspace(cwd: string, withDocs: boolean): void {
	const files = {
		...INPUT_FILES,
		...(withDocs ? { ...DURABLE_DOCS, "docs/plan-phase-2.md": PLAN } : { "TODO.md": TODO }),
	};
	for (const [path, text] of Object.entries(files)) {
		const target = join(cwd, path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, text);
	}
}

function optionText(option: { label: string; description: string }): string {
	return `${option.label} ${option.description}`;
}

function adoptionQuestion(question: { header: string; question: string }): boolean {
	return (
		/\badopt(?:ion)?\b/i.test(question.header) ||
		/\b(?:which|choose|select)\b.*\b(?:documents?|docs?|files?)\b.*\b(?:adopt|become|include|add)\b/i.test(
			question.question,
		)
	);
}

export function answerImportQuestions(
	call: CapturedToolCall,
	choice: ImportChoice,
): AskUserQuestionResult {
	if (!isAskUserQuestionArgs(call.args)) throw new Error("Malformed importing questionnaire");
	return {
		cancelled: false,
		answers: call.args.questions.map((question, questionIndex) => {
			if (adoptionQuestion(question)) {
				if (!question.multiSelect) throw new Error("Adoption must be a multi-select choice");
				return {
					questionIndex,
					question: question.question,
					kind: "multi",
					selected: [],
					answer:
						choice === "accept"
							? "Adopt exactly docs/architecture.md and docs/adr/0001-pure-resize-pipeline.md in place; adopt no other files."
							: "Adopt none. Preserve docs/architecture.md and docs/adr/0001-pure-resize-pipeline.md unchanged as input only.",
				};
			}
			return {
				questionIndex,
				question: question.question,
				kind: question.multiSelect ? "multi" : "custom",
				...(question.multiSelect ? { selected: [] } : {}),
				answer: MAINTAINER_INTENT,
			};
		}),
	};
}

function questionsOf(log: EventLog) {
	return log
		.toolCalls("ask_user_question")
		.flatMap((call) => (isAskUserQuestionArgs(call.args) ? call.args.questions : []));
}

export function importChecks(choice: ImportChoice) {
	const adopted = choice === "accept";
	return [
		checks.custom("the graph is validated after its last file write", ({ log }) => {
			const lastWrite = log.events.findLastIndex(
				(event) =>
					event.type === "tool_execution_end" &&
					["apply_patch", "spec_create", "spec_update", "spec_delete"].includes(event.toolName),
			);
			return log.toolCalls("spec_validate").some((call) => {
				const started = log.events.findIndex(
					(event) => event.type === "tool_execution_start" && event.toolCallId === call.toolCallId,
				);
				const details =
					call.result && typeof call.result === "object" && "details" in call.result
						? call.result.details
						: null;
				return (
					lastWrite >= 0 &&
					started > lastWrite &&
					!call.isError &&
					details !== null &&
					typeof details === "object" &&
					"danglingLinks" in details &&
					Array.isArray(details.danglingLinks) &&
					details.danglingLinks.length === 0 &&
					"duplicateIds" in details &&
					Array.isArray(details.duplicateIds) &&
					details.duplicateIds.length === 0 &&
					"parentCycles" in details &&
					Array.isArray(details.parentCycles) &&
					details.parentCycles.length === 0
				);
			});
		}),
		checks.expectSkillRead("writing-specs"),
		checks.custom(
			"durable candidates are offered together, process documents are not",
			({ log }) => {
				const questions = questionsOf(log);
				const offers = questions.filter(adoptionQuestion);
				const options = offers
					.flatMap((question) => question.options)
					.map(optionText)
					.join("\n");
				if (/plan-phase-2|README\.md|CHANGELOG\.md|TODO\.md/i.test(options)) return false;
				if (choice === "no-docs") return offers.length === 0;
				return (
					log.toolCalls("ask_user_question").length === 1 &&
					offers.length === 1 &&
					offers[0]?.multiSelect === true &&
					/architecture/i.test(JSON.stringify(offers[0].options)) &&
					/adr|pure-resize-pipeline/i.test(JSON.stringify(offers[0].options))
				);
			},
		),
		checks.custom("native question results retain the actual candidate choices", ({ log }) =>
			log.toolCalls("ask_user_question").every((call) => {
				const details =
					call.result && typeof call.result === "object" && "details" in call.result
						? call.result.details
						: null;
				return (
					!call.isError &&
					isAskUserQuestionArgs(call.args) &&
					call.args.questions.every(
						(question) => !adoptionQuestion(question) || question.multiSelect,
					) &&
					isAskUserQuestionResult(details) &&
					isDeepStrictEqual(details, answerImportQuestions(call, choice))
				);
			}),
		),
		...Object.entries({
			...INPUT_FILES,
			...(choice === "no-docs" ? { "TODO.md": TODO } : { "docs/plan-phase-2.md": PLAN }),
		}).map(([path, text]) => checks.expectFile(path, (content) => content === text)),
		...(choice === "no-docs"
			? []
			: Object.entries(DURABLE_DOCS).map(([path, text]) =>
					checks.expectFile(path, (content) => {
						if (!adopted) return content === text;
						const parsed = parseFile(content);
						return (
							parsed.frontmatter !== null && (parsed.body === text || parsed.body === `\n${text}`)
						);
					}),
				)),
		checks.custom(
			"draft graph has a goal, one architecture and both real module boundaries",
			({ cwd }) => {
				const index = new SpecIndex(cwd);
				const graph = index.graph();
				const nodes = [...graph.nodes.values()];
				const roots = nodes.filter((node) => node.type === "goal-and-requirements");
				const architecture = nodes.filter(
					(node) => node.type === "architecture-design" && !node.path.startsWith("docs/adr/"),
				);
				const root = roots[0];
				const arch = architecture[0];
				if (roots.length !== 1 || architecture.length !== 1 || !root || !arch) return false;
				if (!root.path.endsWith("goal-and-requirements.md") || scalar(root.frontmatter, "parent"))
					return false;
				if (scalar(arch.frontmatter, "parent") !== root.id) return false;
				if (adopted && arch.path !== "docs/architecture.md") return false;
				if (!isValid(validateGraph(graph))) return false;
				if (nodes.some((node) => scalar(node.frontmatter, "status") !== "draft" || !node.title))
					return false;
				const modules = nodes.filter((node) =>
					["module-design", "submodule-design"].includes(node.type),
				);
				if (modules.length !== 2) return false;
				for (const path of ["src/cli/SPEC.md", "src/resize/SPEC.md"]) {
					const node = modules.find((item) => item.path === path);
					if (!node || scalar(node.frontmatter, "parent") !== arch.id) return false;
					const body = parseFile(readFileSync(join(cwd, path), "utf8")).body;
					if (
						!/responsibilit/i.test(body) ||
						!/boundar|depend|import|reach/i.test(body) ||
						!body.replace(/^#+.*$/gm, "").trim()
					)
						return false;
				}
				const body = index.recordForId(arch.id)?.content ?? "";
				if (!/cli[^\n.]*?(?:calls|imports|depends|→|->)[^\n.]*?resize/i.test(body)) return false;
				if (!/resize[^\n.]*?(?:never|must not|does not|no)[^\n.]*?cli/i.test(body)) return false;
				const cli = modules.find((node) => node.path === "src/cli/SPEC.md");
				const resize = modules.find((node) => node.path === "src/resize/SPEC.md");
				if (
					graph.edges.some(
						(edge) => edge.kind === "depends-on" && edge.from === resize?.id && edge.to === cli?.id,
					)
				)
					return false;
				if (adopted) {
					const adr = nodes.find((node) => node.path === "docs/adr/0001-pure-resize-pipeline.md");
					if (!adr || !graph.edges.some((edge) => edge.from === adr.id && edge.to === arch.id))
						return false;
				}
				return true;
			},
		),
	];
}

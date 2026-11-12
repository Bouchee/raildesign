import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type Tool, tool } from "@openai/agents";
import type { WireModel } from "@thinkrail/contracts";
import { z } from "zod";
import type { SkillAdmissionContext } from "./skillAdmission";
import { budgetedSkillsSection, catalogBudgetChars, createSkillSearchTool } from "./skillCatalog";
import {
	formatSkillsForPrompt,
	loadSkillInventory,
	type Skill,
	type SkillLoadOptions,
	stripSkillFrontmatter,
} from "./skills";

const FILE_LIMIT = 128 * 1024;

export interface SkillToolOptions {
	cwd: string;
	admission: () => SkillAdmissionContext;
	loadOptions?: SkillLoadOptions;
	manualSkills?: readonly string[];
	allowedSkills?: readonly string[];
	markToolFailed?: (callId: string | undefined) => void;
	assertActive: () => void;
	signal: AbortSignal;
}

function admittedSkills(options: SkillToolOptions): Skill[] {
	options.assertActive();
	options.signal.throwIfAborted();
	return loadSkillInventory(options.cwd, options.admission(), options.loadOptions)
		.entries.filter(
			({ catalog }) =>
				catalog.decision === "load" &&
				(!options.allowedSkills || options.allowedSkills.includes(catalog.name)),
		)
		.map(({ skill }) => skill);
}

function readText(path: string): string {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > FILE_LIMIT)
			throw new Error("Instruction files must be regular files of at most 128 KiB");
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

function readSkill(
	options: SkillToolOptions,
	name: string,
	resource: string | null,
	manual: boolean,
): { path: string; text: string } {
	const skill = admittedSkills(options).find((entry) => entry.name === name);
	if (!skill || (skill.disableModelInvocation && !manual && !options.manualSkills?.includes(name)))
		throw new Error("This Skill is unavailable or not approved");
	if (resource !== null && (isAbsolute(resource) || resource.split(/[\\/]/).includes(".git")))
		throw new Error("Use a resource path relative to the selected Skill");
	const root = realpathSync(skill.baseDir);
	const target = resource === null ? skill.filePath : resolve(skill.baseDir, resource);
	const actual = realpathSync(target);
	if (!actual.startsWith(`${root}${sep}`))
		throw new Error("Skill resources must stay in the selected Skill directory");
	const text = readText(actual);
	options.assertActive();
	options.signal.throwIfAborted();
	return {
		path: actual,
		text: actual === skill.filePath ? stripSkillFrontmatter(text).trim() : text,
	};
}

export function readAdmittedSkill(
	options: SkillToolOptions,
	name: string,
	resource: string | null,
): { path: string; text: string } {
	return readSkill(options, name, resource, false);
}

export function skillCommandName(input: string): string | undefined {
	return input.match(/^\/skill:([^\s]+)(?:\s+[\s\S]*)?$/)?.[1];
}

export function expandSkillCommand(options: SkillToolOptions, input: string): string {
	const match = input.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match?.[1]) return input;
	const body = readSkill(options, match[1], null, true);
	return `<skill name=${JSON.stringify(match[1])} path=${JSON.stringify(body.path)}>\n${body.text}\n</skill>\n${match[2] ?? ""}`;
}

export function createSkillTools(options: SkillToolOptions): Tool[] {
	return [
		createSkillSearchTool(() => admittedSkills(options), options.markToolFailed),
		tool({
			name: "skill_read",
			description:
				"Read an approved Skill body or a text resource inside that Skill. Use null for the Skill body.",
			parameters: z.object({ name: z.string().min(1), path: z.string().min(1).nullable() }),
			errorFunction: (_context, error, details) => {
				options.markToolFailed?.(details?.toolCall?.callId);
				return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
			},
			execute: ({ name, path }) => readAdmittedSkill(options, name, path),
		}),
	];
}

export function skillInstructions(
	options: SkillToolOptions,
	model?: Pick<WireModel, "contextWindow">,
): string {
	const skills = admittedSkills(options);
	const catalog =
		budgetedSkillsSection(skills, catalogBudgetChars(model))?.text ?? formatSkillsForPrompt(skills);
	return [
		catalog,
		"Search the approved Skill catalog with skill_search. Read a matching Skill with skill_read before following it. Read its resources only when necessary.",
	].join("\n");
}

export function workspaceInstructions(cwd: string): string {
	const directories: string[] = [];
	for (let directory = realpathSync(cwd); ; directory = dirname(directory)) {
		directories.unshift(directory);
		if (dirname(directory) === directory) break;
	}
	let bytes = 0;
	const instructions = directories.flatMap((directory) => {
		const path = join(directory, "AGENTS.md");
		if (!existsSync(path)) return [];
		if (lstatSync(path).isSymbolicLink())
			throw new Error("Workspace instructions must not be symbolic links");
		const text = readText(path);
		bytes += Buffer.byteLength(text);
		if (bytes > FILE_LIMIT) throw new Error("Workspace instructions exceed 128 KiB");
		return [
			`<workspace_instructions path=${JSON.stringify(path)}>\n${text}\n</workspace_instructions>`,
		];
	});
	return [
		...instructions,
		"Before changing a nested directory, read its applicable AGENTS.md files. More specific instructions apply to that directory.",
	].join("\n");
}

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	SkillCatalogEntry,
	SlashCommandInfo,
	SlashCommandSourceInfo,
} from "@thinkrail/contracts";
import { parse as parseYaml } from "yaml";
import { extensionSkillRoots, STAGED_HOST_SKILLS_ROUTE, serverExtensions } from "../extensions";
import { dataDir, isRecord } from "../persistence";
import { decideSkill, type SkillAdmissionContext, sourceMayLoad } from "./skillAdmission";
import { type CompatibilitySkillSource, discoverCompatibilitySkillSources } from "./skillSources";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SlashCommandSourceInfo;
	disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
	path: string;
	code: "unreadable" | "outside-root" | "invalid-frontmatter" | "missing-description";
}

export interface SkillLoadOptions {
	applicationDir?: string;
	homeDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	bundledPaths?: readonly string[];
	disabledExtensions?: ReadonlySet<string>;
}

interface SkillRoot {
	path: string;
	source: string;
	scope: SlashCommandSourceInfo["scope"];
	group: string;
	plugin?: string;
	resource: boolean;
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

export function stripSkillFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

export function parseSkillBlock(text: string): { name: string; userMessage: string } | undefined {
	const match = text.match(/^\s*<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/);
	return match ? { name: match[1] ?? "", userMessage: match[2] ?? "" } : undefined;
}

export function formatSkillsForPrompt(skills: readonly Skill[]): string {
	const escapeXml = (text: string) =>
		text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const listed = skills.filter((skill) => !skill.disableModelInvocation);
	if (listed.length === 0) return "";
	return `<available_skills>\n${listed
		.map(
			(skill) =>
				`<skill>\n<name>${escapeXml(skill.name)}</name>\n<description>${escapeXml(skill.description)}</description>\n<location>${escapeXml(skill.filePath)}</location>\n</skill>`,
		)
		.join("\n")}\n</available_skills>`;
}

let bundledSkillsDir: string | undefined;

/** Physical content staged by CLI/desktop launchers; no extension executor is registered here. */
export function setBundledSkillPaths(skillsDir: string | undefined): void {
	bundledSkillsDir = skillsDir === undefined ? undefined : resolve(skillsDir);
}

function bundledRoots(options: SkillLoadOptions): readonly string[] {
	if (options.bundledPaths) return options.bundledPaths;
	let hostPaths: string[];
	if (bundledSkillsDir === undefined) {
		const require = createRequire(import.meta.url);
		hostPaths = [
			...["pi-spec-graph", "@thinkrail/workflow", "pi-todos"].map((name) =>
				join(dirname(require.resolve(`${name}/package.json`)), "skills"),
			),
			fileURLToPath(new URL("../../skills", import.meta.url)),
		];
	} else {
		hostPaths = [join(bundledSkillsDir, STAGED_HOST_SKILLS_ROUTE)];
	}
	return [
		...hostPaths,
		...serverExtensions.flatMap((entry) =>
			options.disabledExtensions?.has(entry.extension.name)
				? []
				: extensionSkillRoots(entry, bundledSkillsDir),
		),
	];
}

function aliasRoot(source: CompatibilitySkillSource): SkillRoot {
	return {
		path: source.path,
		source: source.provider,
		scope: source.scope,
		group: source.plugin ?? (source.scope === "project" ? "project" : "personal"),
		...(source.plugin ? { plugin: source.plugin } : {}),
		resource: false,
	};
}

function rootsFor(cwd: string, options: SkillLoadOptions): SkillRoot[] {
	const home = resolve(options.homeDir ?? options.env?.HOME ?? homedir());
	const personalAgents = join(home, ".agents", "skills");
	const projectAgents: SkillRoot[] = [];
	for (let directory = resolve(cwd); ; directory = dirname(directory)) {
		const path = join(directory, ".agents", "skills");
		if (path !== personalAgents)
			projectAgents.push({
				path,
				source: "agents",
				scope: "project",
				group: "application",
				resource: true,
			});
		if (dirname(directory) === directory) break;
	}
	const aliases = discoverCompatibilitySkillSources(cwd, options);
	return [
		{
			path: join(options.applicationDir ?? dataDir(), "skills"),
			source: "raildesign",
			scope: "user",
			group: "application",
			resource: false,
		},
		{
			path: personalAgents,
			source: "agents",
			scope: "user",
			group: "application",
			resource: false,
		},
		{
			path: join(cwd, ".raildesign", "skills"),
			source: "raildesign",
			scope: "project",
			group: "application",
			resource: true,
		},
		...projectAgents,
		...bundledRoots(options).map(
			(path): SkillRoot => ({
				path,
				source: "bundled",
				scope: "temporary",
				group: "bundled",
				resource: false,
			}),
		),
		...aliases.filter((source) => source.scope === "user").map(aliasRoot),
		...aliases.filter((source) => source.scope === "project").map(aliasRoot),
	];
}

function readRoot(root: SkillRoot, diagnostics: SkillDiagnostic[]): Skill[] {
	if (!existsSync(root.path)) return [];
	let canonical: string;
	try {
		canonical = realpathSync(root.path);
	} catch {
		diagnostics.push({ path: root.path, code: "unreadable" });
		return [];
	}
	const skills: Skill[] = [];
	const visited = new Set<string>();
	const visit = (directory: string, top: boolean) => {
		let actual: string;
		try {
			actual = realpathSync(directory);
		} catch {
			diagnostics.push({ path: directory, code: "unreadable" });
			return;
		}
		if (!within(actual, canonical)) {
			diagnostics.push({ path: directory, code: "outside-root" });
			return;
		}
		if (visited.has(actual)) return;
		visited.add(actual);
		let names: string[];
		try {
			names = readdirSync(directory).sort();
		} catch {
			diagnostics.push({ path: directory, code: "unreadable" });
			return;
		}
		const declared = names.includes("SKILL.md");
		for (const name of names) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const path = join(directory, name);
			let file: string;
			try {
				file = realpathSync(path);
				if (!within(file, canonical)) {
					diagnostics.push({ path, code: "outside-root" });
					continue;
				}
				if (statSync(file).isDirectory()) {
					if (!declared) visit(path, false);
					continue;
				}
			} catch {
				diagnostics.push({ path, code: "unreadable" });
				continue;
			}
			if (name !== "SKILL.md" && (!top || declared || !name.endsWith(".md"))) continue;
			let metadata: unknown;
			try {
				const raw = readFileSync(file, "utf8");
				const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
				metadata = frontmatter === undefined ? {} : parseYaml(frontmatter);
			} catch {
				diagnostics.push({ path, code: "invalid-frontmatter" });
				continue;
			}
			if (
				!isRecord(metadata) ||
				typeof metadata.description !== "string" ||
				!metadata.description.trim()
			) {
				if (name === "SKILL.md") diagnostics.push({ path, code: "missing-description" });
				continue;
			}
			skills.push({
				name:
					typeof metadata.name === "string" && metadata.name
						? metadata.name
						: basename(dirname(file)),
				description: metadata.description,
				filePath: file,
				baseDir: dirname(file),
				sourceInfo: {
					path: file,
					source: root.source,
					scope: root.scope,
					origin: "top-level",
					baseDir: canonical,
				},
				disableModelInvocation: metadata["disable-model-invocation"] === true,
			});
		}
	};
	visit(root.path, true);
	return skills;
}

export function loadSkillInventory(
	cwd: string,
	admission: SkillAdmissionContext,
	options: SkillLoadOptions = {},
) {
	const diagnostics: SkillDiagnostic[] = [];
	const seen = new Set<string>();
	const roots = rootsFor(cwd, options);
	// Withheld roots must not shadow an admitted Skill with the same name.
	const deferred = (root: SkillRoot) =>
		(root.resource && !admission.resourceTrusted) ||
		((root.group === "project" || root.group === "personal" || root.plugin !== undefined) &&
			!sourceMayLoad({ group: root.group, isPlugin: root.plugin !== undefined }, admission));
	const ordered = [...roots.filter((root) => !deferred(root)), ...roots.filter(deferred)];
	const entries = ordered.flatMap((root) =>
		readRoot(root, diagnostics).flatMap((skill) => {
			if (seen.has(skill.name)) return [];
			seen.add(skill.name);
			const facts = {
				name: skill.name,
				isProjectAlias: root.group === "project",
				group: root.group,
				isPlugin: root.plugin !== undefined,
			};
			const decision =
				root.resource && !admission.resourceTrusted ? "untrusted" : decideSkill(facts, admission);
			return [
				{
					skill,
					catalog: {
						name: skill.name,
						description: skill.description,
						sourceInfo: skill.sourceInfo,
						gated: root.resource || facts.isProjectAlias,
						group: root.group,
						decision,
						...(root.plugin ? { plugin: root.plugin } : {}),
						...(skill.disableModelInvocation ? { manualOnly: true } : {}),
					} satisfies SkillCatalogEntry,
				},
			];
		}),
	);
	return { entries, diagnostics };
}

export async function listSkillCatalog(
	cwd: string,
	admission: SkillAdmissionContext,
	options: SkillLoadOptions = {},
): Promise<SkillCatalogEntry[]> {
	return loadSkillInventory(cwd, admission, options).entries.map((entry) => entry.catalog);
}

export async function listSkillCommands(
	cwd: string,
	admission: SkillAdmissionContext,
	options: SkillLoadOptions = {},
): Promise<SlashCommandInfo[]> {
	return loadSkillInventory(cwd, admission, options)
		.entries.filter(({ catalog }) => catalog.decision === "load")
		.map(({ skill }) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		}));
}

export async function listProjectAliasSkillNames(
	cwd: string,
	options: SkillLoadOptions = {},
): Promise<string[]> {
	const diagnostics: SkillDiagnostic[] = [];
	return [
		...new Set(
			discoverCompatibilitySkillSources(cwd, options)
				.filter((source) => source.scope === "project")
				.flatMap((source) => readRoot(aliasRoot(source), diagnostics).map((skill) => skill.name)),
		),
	];
}

export function readSkillBody(skill: Skill): string {
	const file = realpathSync(skill.filePath);
	const declaredRoot = resolve(skill.sourceInfo.baseDir ?? skill.baseDir);
	const root = realpathSync(declaredRoot);
	if (root !== declaredRoot || !within(file, root) || !statSync(file).isFile())
		throw new Error("Skill path leaves its declared source root");
	return stripSkillFrontmatter(readFileSync(file, "utf8")).trim();
}

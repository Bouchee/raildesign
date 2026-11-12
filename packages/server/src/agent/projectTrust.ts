import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectResourceKind, ProjectTrustSummary } from "@thinkrail/contracts";
import { dataDir } from "../persistence";
import { loadMcpConfigFiles } from "./mcp";
import { listProjectAliasSkillNames, type SkillLoadOptions } from "./skills";

const APPLICATION_RESOURCES: ReadonlyArray<[ProjectResourceKind, string]> = [
	["extensions", "extensions"],
	["settings", "settings.json"],
	["skills", "skills"],
	["prompts", "prompts"],
	["themes", "themes"],
	["systemPrompt", "SYSTEM.md"],
	["systemPrompt", "APPEND_SYSTEM.md"],
];

function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

function hasAgentDefinitions(path: string): boolean {
	try {
		return readdirSync(path).some((name) => name.endsWith(".md"));
	} catch {
		return false;
	}
}

function applicationResourceKinds(cwd: string, options: SkillLoadOptions): ProjectResourceKind[] {
	const applicationDir = join(canonical(cwd), ".raildesign");
	const kinds = new Set<ProjectResourceKind>();
	for (const [kind, entry] of APPLICATION_RESOURCES)
		if (existsSync(join(applicationDir, entry))) kinds.add(kind);
	const personal = join(
		canonical(options.homeDir ?? options.env?.HOME ?? homedir()),
		".agents",
		"skills",
	);
	for (let directory = canonical(cwd); ; directory = dirname(directory)) {
		const skills = join(directory, ".agents", "skills");
		if (skills !== personal && existsSync(skills)) kinds.add("skills");
		if (dirname(directory) === directory) break;
	}
	if (
		hasAgentDefinitions(join(applicationDir, "agents")) ||
		hasAgentDefinitions(join(cwd, ".agents", "agents"))
	)
		kinds.add("subagents");
	return [...kinds];
}

/** Inventory only. Grants come from the current Project record, never another runtime's trust store. */
export async function projectTrustSummary(
	cwd: string,
	options: SkillLoadOptions = {},
): Promise<ProjectTrustSummary> {
	const mcpServers = loadMcpConfigFiles({
		agentDir: options.applicationDir ?? dataDir(),
		cwd,
		projectTrusted: true,
	}).entries.filter((entry) => entry.scope === "project").length;
	return {
		aliasSkills: await listProjectAliasSkillNames(cwd, options),
		applicationResources: applicationResourceKinds(cwd, options),
		mcpServers,
	};
}

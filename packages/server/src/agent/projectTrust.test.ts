import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectResourceKind } from "@thinkrail/contracts";
import { projectTrustSummary } from "./projectTrust";

let root: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-trust-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({
	homeDir: join(root, "home"),
	applicationDir: join(root, "data"),
	env: {},
	bundledPaths: [],
});
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

test("an empty project requires no resource or alias grants", async () => {
	expect(await projectTrustSummary(cwd, options())).toEqual({
		aliasSkills: [],
		applicationResources: [],
		mcpServers: 0,
	});
});

test("the summary inventories every application resource kind without executing files", async () => {
	const files: Array<[ProjectResourceKind, string]> = [
		["extensions", "extensions/x.ts"],
		["settings", "settings.json"],
		["skills", "skills/s/SKILL.md"],
		["prompts", "prompts/kickoff.md"],
		["themes", "themes/t.json"],
		["systemPrompt", "SYSTEM.md"],
		["systemPrompt", "APPEND_SYSTEM.md"],
		["subagents", "agents/reviewer.md"],
	];
	for (const [index, [kind, path]] of files.entries()) {
		const directory = join(cwd, String(index));
		write(join(directory, ".raildesign", path), "throw new Error('must not execute')");
		expect((await projectTrustSummary(directory, options())).applicationResources).toEqual([kind]);
	}
});

test("external alias acknowledgement names remain separate from resource and MCP inventory", async () => {
	const contents = "---\nname: deploy\ndescription: Deploy safely\n---\nBody.";
	write(join(cwd, ".claude/skills/deploy/SKILL.md"), contents);
	write(join(cwd, ".github/skills/deploy/SKILL.md"), contents);
	write(join(cwd, ".agents/skills/native/SKILL.md"), contents.replace("deploy", "native"));
	write(
		join(cwd, ".agents/agents/reviewer.md"),
		"---\nname: reviewer\ndescription: Review\n---\nReview.",
	);
	write(
		join(cwd, ".raildesign/mcp.json"),
		JSON.stringify({
			mcpServers: { docs: { url: "https://docs.example/mcp" }, disabled: { enabled: false } },
		}),
	);
	expect(await projectTrustSummary(cwd, options())).toEqual({
		aliasSkills: ["deploy"],
		applicationResources: ["skills", "subagents"],
		mcpServers: 2,
	});
});

test("ancestor resource roots are reported but personal HOME .agents does not grant the project trust", async () => {
	write(join(root, ".agents/skills/shared/SKILL.md"), "body");
	expect((await projectTrustSummary(cwd, options())).applicationResources).toEqual(["skills"]);
	rmSync(join(root, ".agents"), { recursive: true });
	write(join(root, "home/.agents/skills/personal/SKILL.md"), "body");
	expect((await projectTrustSummary(cwd, options())).applicationResources).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admissionContextFor } from "./skillAdmission";
import {
	formatSkillsForPrompt,
	listProjectAliasSkillNames,
	listSkillCommands,
	loadSkillInventory,
	parseSkillBlock,
	readSkillBody,
	type SkillLoadOptions,
	setBundledSkillPaths,
} from "./skills";

let root: string;
let cwd: string;
let options: SkillLoadOptions;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-skills-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
	options = {
		applicationDir: join(root, "data"),
		homeDir: join(root, "home"),
		env: {},
		bundledPaths: [],
	};
});
afterEach(() => {
	setBundledSkillPaths(undefined);
	rmSync(root, { recursive: true, force: true });
});
function write(path: string, contents: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}
function skill(path: string, name: string, metadata = "") {
	write(
		path,
		`---\nname: ${name}\ndescription: Instructions for ${name}\n${metadata}---\n\nBody for ${name}.\n`,
	);
}
const entries = (
	trusted = false,
	resourceTrust: "granted" | "untrusted" = "untrusted",
	acknowledgedSkills: string[] = [],
) =>
	loadSkillInventory(
		cwd,
		admissionContextFor({ trusted, resourceTrust, acknowledgedSkills }),
		options,
	);

test("application resource trust and external project alias acknowledgements remain distinct", async () => {
	skill(join(cwd, ".raildesign/skills/native/SKILL.md"), "native");
	skill(join(cwd, ".agents/skills/shared/SKILL.md"), "shared");
	skill(join(cwd, ".claude/skills/alias/SKILL.md"), "alias");
	const decisions = (
		trusted: boolean,
		resources: "granted" | "untrusted",
		acknowledged: string[] = [],
	) =>
		Object.fromEntries(
			entries(trusted, resources, acknowledged).entries.map(({ catalog }) => [
				catalog.name,
				catalog.decision,
			]),
		);
	expect(decisions(false, "untrusted")).toEqual({
		native: "untrusted",
		shared: "untrusted",
		alias: "untrusted",
	});
	expect(decisions(true, "untrusted", ["alias"])).toEqual({
		native: "untrusted",
		shared: "untrusted",
		alias: "load",
	});
	expect(decisions(false, "granted")).toEqual({
		native: "load",
		shared: "load",
		alias: "untrusted",
	});
	expect(decisions(true, "granted")).toEqual({
		native: "load",
		shared: "load",
		alias: "pending-ack",
	});
	expect(await listProjectAliasSkillNames(cwd, options)).toEqual(["alias"]);
});

test("personal external and plugin roots remain opt-in and cannot shadow admitted names while off", () => {
	skill(join(root, "home/.claude/skills/pdf/SKILL.md"), "pdf");
	skill(join(cwd, ".github/skills/pdf/SKILL.md"), "pdf");
	const context = admissionContextFor({ trusted: true, acknowledgedSkills: ["pdf"] });
	const off = loadSkillInventory(cwd, context, options).entries;
	expect(off.map(({ catalog }) => [catalog.name, catalog.decision, catalog.group])).toEqual([
		["pdf", "load", "project"],
	]);
	const on = loadSkillInventory(cwd, { ...context, enabledGroups: ["personal"] }, options).entries;
	expect(on.map(({ catalog }) => [catalog.name, catalog.decision, catalog.group])).toEqual([
		["pdf", "load", "personal"],
	]);
});

test("manual Skills stay out of model listings while available as explicit commands", async () => {
	skill(join(root, "data/skills/manual/SKILL.md"), "manual", "disable-model-invocation: true\n");
	const inventory = entries().entries;
	expect(inventory[0]?.catalog.manualOnly).toBe(true);
	expect(formatSkillsForPrompt(inventory.map(({ skill }) => skill))).toBe("");
	expect(
		(await listSkillCommands(cwd, admissionContextFor(undefined), options)).map(({ name }) => name),
	).toEqual(["skill:manual"]);
});

test("nested content parses YAML, ignores undeclared markdown and reports invalid metadata", () => {
	write(join(root, "data/skills/README.md"), "# Readme");
	write(join(root, "data/skills/bad/SKILL.md"), "---\nname: [unterminated\n---\n");
	write(join(root, "data/skills/empty/SKILL.md"), "---\nname: empty\n---\n");
	write(
		join(root, "data/skills/nested/deep/SKILL.md"),
		"---\nname: deep\ndescription: >\n  Multiple\n  lines\n---\nBody.",
	);
	const inventory = entries();
	expect(inventory.entries.map(({ skill }) => skill.name)).toEqual(["deep"]);
	expect(inventory.entries[0]?.skill.description).toBe("Multiple lines\n");
	expect(inventory.diagnostics.map(({ code }) => code).sort()).toEqual([
		"invalid-frontmatter",
		"missing-description",
	]);
	const parsed = inventory.entries[0]?.skill;
	if (!parsed) throw new Error("Missing parsed Skill");
	expect(readSkillBody(parsed)).toBe("Body.");
});

test("resource roots on ancestors are gated and HOME .agents remains personal", () => {
	skill(join(root, ".agents/skills/ancestor/SKILL.md"), "ancestor");
	skill(join(root, "home/.agents/skills/personal/SKILL.md"), "personal");
	expect(entries().entries.map(({ catalog }) => [catalog.name, catalog.decision])).toEqual([
		["personal", "load"],
		["ancestor", "untrusted"],
	]);
	expect(
		entries(false, "granted").entries.every(({ catalog }) => catalog.decision === "load"),
	).toBe(true);
});

test("a symlink cannot add outside content or turn an admitted Skill into an outside read", () => {
	const allowed = join(root, "data/skills");
	skill(join(allowed, "safe/SKILL.md"), "safe");
	skill(join(root, "outside/evil/SKILL.md"), "evil");
	symlinkSync(join(root, "outside"), join(allowed, "escape"));
	const inventory = entries();
	expect(inventory.entries.map(({ skill }) => skill.name)).toEqual(["safe"]);
	expect(inventory.diagnostics).toContainEqual({
		path: join(allowed, "escape"),
		code: "outside-root",
	});
	const safe = inventory.entries[0]?.skill;
	if (!safe) throw new Error("Missing admitted Skill");
	expect(readSkillBody(safe)).toBe("Body for safe.");
	rmSync(safe.filePath);
	symlinkSync(join(root, "outside/evil/SKILL.md"), safe.filePath);
	expect(() => readSkillBody(safe)).toThrow("declared source root");
	renameSync(allowed, join(root, "old-skills"));
	symlinkSync(join(root, "outside"), allowed);
	mkdirSync(join(root, "outside/safe"));
	writeFileSync(join(root, "outside/safe/SKILL.md"), "secret");
	expect(() => readSkillBody(safe)).toThrow("declared source root");
});

test("Skill expansion identifies the selected name and trailing user request", () => {
	expect(
		parseSkillBlock('  <skill name="pdf" location="/a/SKILL.md">Body</skill>\nFill it.'),
	).toEqual({ name: "pdf", userMessage: "Fill it." });
	expect(parseSkillBlock("ordinary request")).toBeUndefined();
});

test("default content roots retain bundled workflow, TODO, spec and host Skills", () => {
	const inventory = loadSkillInventory(cwd, admissionContextFor(undefined), {
		applicationDir: join(root, "data"),
		homeDir: join(root, "home"),
		env: {},
	});
	const admitted = inventory.entries
		.filter(({ catalog }) => catalog.decision === "load")
		.map(({ skill }) => skill.name);
	for (const name of ["choosing-a-workflow", "todos", "spec-graph", "managing-mcp-servers"])
		expect(admitted).toContain(name);
});

test("staged launchers select physical Skill paths and retain extension disable policy", () => {
	const stage = join(root, "staged-skills");
	skill(join(stage, "host/staged/SKILL.md"), "staged-host");
	skill(join(stage, "extensions/web-access/librarian/SKILL.md"), "staged-extension");
	setBundledSkillPaths(stage);
	const stagedOptions = {
		applicationDir: join(root, "data"),
		homeDir: join(root, "home"),
		env: {},
	};
	const inventory = loadSkillInventory(cwd, admissionContextFor(undefined), stagedOptions);
	expect(inventory.entries.map(({ skill }) => skill.name)).toEqual([
		"staged-host",
		"staged-extension",
	]);
	expect(
		inventory.entries.every(({ skill }) => skill.filePath.startsWith(realpathSync(stage))),
	).toBe(true);
	const disabled = loadSkillInventory(cwd, admissionContextFor(undefined), {
		...stagedOptions,
		disabledExtensions: new Set(["web-access"]),
	});
	expect(disabled.entries.map(({ skill }) => skill.name)).toEqual(["staged-host"]);
});

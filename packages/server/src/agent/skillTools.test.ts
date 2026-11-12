import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admissionContextFor } from "./skillAdmission";
import {
	expandSkillCommand,
	readAdmittedSkill,
	type SkillToolOptions,
	skillInstructions,
	workspaceInstructions,
} from "./skillTools";

let root: string;
let options: SkillToolOptions;
let disabled: string[];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sdk-skill-tools-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	disabled = [];
	options = {
		cwd,
		admission: () => ({ ...admissionContextFor(undefined), disabled }),
		loadOptions: {
			applicationDir: join(root, "data"),
			homeDir: join(root, "home"),
			env: {},
			bundledPaths: [],
		},
		assertActive() {},
		signal: new AbortController().signal,
	};
	const directory = join(root, "data/skills/demo");
	mkdirSync(join(directory, "references"), { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		"---\nname: demo\ndescription: Test Skill\n---\nFollow these instructions.",
	);
	writeFileSync(join(directory, "references/example.txt"), "Resource content");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("an admitted external Skill supplies its body and resources without general file access", () => {
	expect(readAdmittedSkill(options, "demo", null).text).toBe("Follow these instructions.");
	expect(readAdmittedSkill(options, "demo", "references/example.txt").text).toBe(
		"Resource content",
	);
	expect(skillInstructions(options)).toContain("demo");
	writeFileSync(join(root, "private.txt"), "Private");
	symlinkSync(join(root, "private.txt"), join(root, "data/skills/demo/references/escape.txt"));
	expect(() => readAdmittedSkill(options, "demo", "references/escape.txt")).toThrow(
		"selected Skill directory",
	);
	expect(() => readAdmittedSkill(options, "demo", "../../../../private.txt")).toThrow();
	expect(() => readAdmittedSkill(options, "demo", join(root, "private.txt"))).toThrow("relative");
	disabled = ["demo"];
	expect(() => readAdmittedSkill(options, "demo", null)).toThrow("not approved");
	expect(skillInstructions(options)).not.toContain("<name>demo</name>");
});

test("manual Skill commands retain current admission and do not expose manual-only Skills to automatic reads", () => {
	writeFileSync(
		join(root, "data/skills/demo/SKILL.md"),
		"---\nname: demo\ndescription: Manual\ndisable-model-invocation: true\n---\nManual instructions",
	);
	expect(() => readAdmittedSkill(options, "demo", null)).toThrow("not approved");
	expect(expandSkillCommand(options, "/skill:demo check files")).toContain(
		"Manual instructions\n</skill>\ncheck files",
	);
	expect(expandSkillCommand(options, "ordinary input")).toBe("ordinary input");
	options.manualSkills = ["demo"];
	expect(readAdmittedSkill(options, "demo", "references/example.txt").text).toBe(
		"Resource content",
	);
	disabled = ["demo"];
	expect(() => expandSkillCommand(options, "/skill:demo")).toThrow("not approved");
});

test("workspace instructions preserve ancestor order and reject symbolic links and oversized files", () => {
	writeFileSync(join(root, "AGENTS.md"), "Parent rules");
	writeFileSync(join(options.cwd, "AGENTS.md"), "Workspace rules");
	const instructions = workspaceInstructions(options.cwd);
	expect(instructions.indexOf("Parent rules")).toBeLessThan(
		instructions.indexOf("Workspace rules"),
	);
	rmSync(join(options.cwd, "AGENTS.md"));
	symlinkSync(join(root, "AGENTS.md"), join(options.cwd, "AGENTS.md"));
	expect(() => workspaceInstructions(options.cwd)).toThrow("symbolic links");
	rmSync(join(options.cwd, "AGENTS.md"));
	writeFileSync(join(options.cwd, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
	expect(() => workspaceInstructions(options.cwd)).toThrow("128 KiB");
});

test("a child Skill allowlist limits both metadata and reads", () => {
	options.allowedSkills = [];
	expect(skillInstructions(options)).not.toContain("<name>demo</name>");
	expect(() => readAdmittedSkill(options, "demo", null)).toThrow("not approved");
	options.allowedSkills = ["demo"];
	expect(readAdmittedSkill(options, "demo", null).text).toContain("Follow these instructions");
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Runner } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import { admissionContextFor } from "./skillAdmission";
import {
	budgetedSkillsSection,
	catalogBudgetChars,
	createSkillSearchTool,
	rankSkills,
	SKILL_SEARCH_TOOL,
	searchSkills,
	suggestSkills,
} from "./skillCatalog";
import { formatSkillsForPrompt, loadSkillInventory, readSkillBody, type Skill } from "./skills";

const skill = (
	name: string,
	description: string,
	source = "local",
	scope: "user" | "project" | "temporary" = "user",
): Skill => ({
	name,
	description,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	sourceInfo: { path: `/skills/${name}/SKILL.md`, source, scope, origin: "top-level" },
	disableModelInvocation: false,
});

const many = (count: number, source: string) =>
	Array.from({ length: count }, (_, i) =>
		skill(
			`${source}-skill-${i}`,
			`Helps with ${source} chore number ${i}. ${"Detail ".repeat(40)}`,
			source,
		),
	);

test("the catalog budget is 2% of a known window between 4K and 8K tokens, never over 10% of it", () => {
	const model = (contextWindow: number) =>
		({ contextWindow }) satisfies Parameters<typeof catalogBudgetChars>[0];
	expect(catalogBudgetChars(model(100_000))).toBe(4_000 * 4);
	expect(catalogBudgetChars(model(300_000))).toBe(6_000 * 4);
	expect(catalogBudgetChars(model(1_000_000))).toBe(8_000 * 4);
	expect(catalogBudgetChars(model(16_000))).toBe(1_600 * 4);
	expect(catalogBudgetChars(model(0))).toBe(4_000 * 4);
	expect(catalogBudgetChars(undefined)).toBe(4_000 * 4);
});

test("a catalog that fits keeps the complete section", () => {
	const skills = [skill("pdf", "Fill PDF forms."), skill("git", "Write commit messages.")];
	expect(budgetedSkillsSection(skills, 10_000)).toBeUndefined();
});

test("an oversized catalog stays within budget and names what it left out", () => {
	const skills = [...many(30, "local"), ...many(800, "gemini"), ...many(200, "claude")];
	const full = formatSkillsForPrompt(skills).length;
	const budget = 16_000;
	const section = budgetedSkillsSection(skills, budget)?.text;
	expect(full).toBeGreaterThan(budget * 10);
	expect(section).toBeDefined();
	expect(section?.length).toBeLessThanOrEqual(budget);
	expect(section).toContain(SKILL_SEARCH_TOOL);
	expect(section).toMatch(/Only \d+ of 1030 skills are listed here/);
	expect(section).toMatch(/Unlisted skills by source: gemini \d+, claude 200\.$/);
	expect(section).toContain("<name>local-skill-0</name>");
	expect(section).not.toContain("<name>gemini-skill-799</name>");
	expect(section).not.toContain("<name>claude-skill-0</name>");
});

test("descriptions are shortened in the budgeted section", () => {
	const skills = many(400, "local");
	const section = budgetedSkillsSection(skills, 16_000)?.text ?? "";
	const description = section.match(/<description>(.*?)<\/description>/)?.[1] ?? "";
	expect(description.length).toBeLessThanOrEqual(240);
	expect(description.endsWith("…")).toBe(true);
});

test("project skills rank first, then ThinkRail's, then the application's, then other agents', keeping order within a tier", () => {
	const ranked = rankSkills([
		skill("claude-a", "x", "claude"),
		skill("native-a", "x"),
		skill("bundled-a", "x", "local", "temporary"),
		skill("project-a", "x", "local", "project"),
		skill("gemini-a", "x", "gemini"),
		skill("native-b", "x"),
		{ ...skill("hidden", "x"), disableModelInvocation: true },
	]);
	expect(ranked.map((s) => s.name)).toEqual([
		"project-a",
		"bundled-a",
		"native-a",
		"native-b",
		"claude-a",
		"gemini-a",
	]);
});

test("search ranks by name and description terms and honours the limit", () => {
	const skills = [
		skill("pdf-forms", "Fill and flatten PDF forms."),
		skill("docx", "Edit Word documents, including tables."),
		skill("pdf-extract", "Extract text and tables from a PDF.", "gemini"),
		skill("video", "Render a promo video."),
		{ ...skill("pdf-secret", "PDF things."), disableModelInvocation: true },
	];
	const names = (query: string, limit?: number) =>
		searchSkills(skills, query, limit).map((match) => match.skill.name);
	expect(names("pdf tables")).toEqual(["pdf-extract", "pdf-forms", "docx"]);
	expect(names("PDF", 1)).toHaveLength(1);
	expect(names("PDF", Number.NaN)).toHaveLength(2);
	expect(names("docx")[0]).toBe("docx");
	expect(names("кириллица")).toEqual([]);
	expect(names("   ")).toEqual([]);
});

test("a hint names only unlisted skills the prompt matches distinctively, once each", () => {
	const chores = many(200, "local");
	const quokka = skill(
		"quokka-invoices",
		"Use when reconciling quokka invoices against the payment log.",
	);
	const listedPdf = skill("pdf-forms", "Fill PDF forms.");
	const skills = [listedPdf, ...chores, quokka];
	const unlisted = [...chores.slice(50), quokka];
	const names = (prompt: string, exclude?: ReadonlySet<string>) =>
		suggestSkills(skills, unlisted, prompt, exclude).map((s) => s.name);
	expect(names("Reconcile the quokka invoices in invoices.txt")).toEqual(["quokka-invoices"]);
	expect(names("Reconcile the quokka invoices", new Set(["quokka-invoices"]))).toEqual([]);
	expect(names("Fill the PDF forms")).toEqual([]);
	expect(names("Fix the failing test and help with the chore")).toEqual([]);
	expect(suggestSkills(skills, [], "quokka invoices")).toEqual([]);
});

test("the preserved search uses a public SDK FunctionTool", async () => {
	const skills = [skill("pdf-forms", "Fill PDF forms."), skill("word", "Edit Word documents.")];
	const agent = new Agent({
		name: "Catalog check",
		model: new ScriptedModel([
			modelResponse([
				functionCall(SKILL_SEARCH_TOOL, JSON.stringify({ query: "pdf", limit: 1 }), {
					callId: "search-1",
				}),
			]),
			modelResponse([assistantMessage("done")]),
		]),
		tools: [createSkillSearchTool(() => skills)],
	});
	const result = await new Runner({ tracingDisabled: true }).run(agent, "Find the PDF Skill");
	const output = result.newItems.find((item) => item.type === "tool_call_output_item");
	expect(JSON.stringify(output?.rawItem)).toContain("pdf-forms");
	expect(JSON.stringify(output?.rawItem)).not.toContain("word");
	expect(result.finalOutput).toBe("done");
});

test("an oversized admitted catalog searches an unlisted Skill through SDK and loads its real body", async () => {
	const root = mkdtempSync(join(tmpdir(), "raildesign-catalog-evidence-"));
	try {
		const applicationDir = join(root, "data"),
			homeDir = join(root, "home"),
			cwd = join(root, "project");
		mkdirSync(cwd);
		const write = (directory: string, name: string, description: string, body: string) => {
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
			);
		};
		for (let index = 0; index < 250; index++)
			write(
				join(applicationDir, "skills", `chore-${index}`),
				`chore-${index}`,
				`Routine chore ${index}. ${"Maintenance detail ".repeat(20)}`,
				"Routine body.",
			);
		write(
			join(homeDir, ".agents/skills/quokka-invoices"),
			"quokka-invoices",
			"Reconcile quokka invoices against payment logs.",
			"A reconciliation ends with quokka-reconciled: <N>.",
		);
		write(
			join(cwd, ".raildesign/skills/quokka-admin"),
			"quokka-admin",
			"Reconcile quokka invoices.",
			"Untrusted project instructions.",
		);
		const skills = loadSkillInventory(cwd, admissionContextFor(undefined), {
			applicationDir,
			homeDir,
			env: {},
			bundledPaths: [],
		})
			.entries.filter(({ catalog }) => catalog.decision === "load")
			.map(({ skill }) => skill);
		const section = budgetedSkillsSection(skills, 16_000);
		expect(section?.unlisted.map(({ name }) => name)).toContain("quokka-invoices");
		expect(section?.text).not.toContain("<name>quokka-invoices</name>");
		const agent = new Agent({
			name: "Search evidence",
			model: new ScriptedModel([
				modelResponse([
					functionCall(SKILL_SEARCH_TOOL, JSON.stringify({ query: "quokka invoices", limit: 1 }), {
						callId: "unlisted-search",
					}),
				]),
				modelResponse([assistantMessage("Search complete")]),
			]),
			tools: [createSkillSearchTool(() => skills)],
		});
		const result = await new Runner({ tracingDisabled: true }).run(agent, "Find the invoice Skill");
		const output = JSON.stringify(
			result.newItems.find((item) => item.type === "tool_call_output_item")?.rawItem,
		);
		expect(output).toContain("quokka-invoices");
		expect(output).not.toContain("quokka-admin");
		const target = skills.find(({ name }) => name === "quokka-invoices");
		if (!target) throw new Error("Missing admitted Skill");
		expect(readSkillBody(target)).toBe("A reconciliation ends with quokka-reconciled: <N>.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

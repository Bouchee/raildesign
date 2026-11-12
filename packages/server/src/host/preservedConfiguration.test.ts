import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillCatalogEntry } from "@thinkrail/contracts";
import { saveProjects, saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { stopAllWatches } from "../watch";
import { getWorkspace } from "../workspaces";
import { handleRequest } from "./handlers";

let root: string;
let repo: string;
const savedData = process.env.THINKRAIL_DATA_DIR;
const ctx = { clientKey: "settings-owner" };
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-preserved-config-"));
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	repo = join(root, "repo");
	for (const [path, name] of [
		[".raildesign/skills/local", "preserved-local"],
		[".claude/skills/alias", "preserved-alias"],
	] as const) {
		mkdirSync(join(repo, path), { recursive: true });
		writeFileSync(
			join(repo, path, "SKILL.md"),
			`---\nname: ${name}\ndescription: Preserved policy test\n---\nContent\n`,
		);
	}
	saveProjects([{ id: "project", name: "Test", path: repo, slug: "test", lastOpened: 1 }]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
		},
	]);
	resetConfigCache();
});
afterEach(() => {
	stopAllWatches();
	resetConfigCache();
	if (savedData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedData;
	rmSync(root, { recursive: true, force: true });
});
async function decisions() {
	const catalog = (await handleRequest(
		"skills.state",
		{ workspaceId: "workspace" },
		ctx,
	)) as SkillCatalogEntry[];
	return Object.fromEntries(
		catalog
			.filter((entry) => entry.name.startsWith("preserved-"))
			.map((entry) => [entry.name, entry.decision]),
	);
}

test("real settings routes retain the two Skill trust gates and project/workspace enable decisions", async () => {
	await expect(
		handleRequest(
			"workspace.setSkillOverride",
			{ id: "workspace", name: "preserved-local", override: true },
			ctx,
		),
	).rejects.toThrow();
	await expect(
		handleRequest(
			"project.setSkillEnabled",
			{ id: "project", name: "preserved-local", enabled: "false" },
			ctx,
		),
	).rejects.toThrow();
	expect(await decisions()).toEqual({
		"preserved-local": "untrusted",
		"preserved-alias": "untrusted",
	});
	await expect(
		handleRequest("project.setTrust", { id: "project", trusted: "yes" }, ctx),
	).rejects.toThrow();
	await handleRequest("project.setTrust", { id: "project", trusted: true }, ctx);
	expect(await decisions()).toEqual({ "preserved-local": "untrusted", "preserved-alias": "load" });
	await handleRequest("project.setTrust", { id: "project", trusted: true, resources: true }, ctx);
	expect((await decisions())["preserved-local"]).toBe("load");
	await handleRequest(
		"project.setSkillEnabled",
		{ id: "project", name: "preserved-local", enabled: false },
		ctx,
	);
	expect((await decisions())["preserved-local"]).toBe("disabled");
	await handleRequest(
		"workspace.setSkillOverride",
		{ id: "workspace", name: "preserved-local", override: "on" },
		ctx,
	);
	expect((await decisions())["preserved-local"]).toBe("load");
	await handleRequest("project.setTrust", { id: "project", trusted: false }, ctx);
	expect(await decisions()).toEqual({
		"preserved-local": "untrusted",
		"preserved-alias": "untrusted",
	});
	expect(await handleRequest("project.trustSummary", { projectId: "project" }, ctx)).toMatchObject({
		aliasSkills: ["preserved-alias"],
		applicationResources: ["skills"],
	});
});

test("web tools do not retain the removed provider's librarian Skill", async () => {
	for (const disabledExtensions of [[], ["web-access"]]) {
		await handleRequest("settings.update", { config: { disabledExtensions } }, ctx);
		for (const [method, params] of [
			["skill.list", { projectId: "project" }],
			["project.skills", { projectId: "project" }],
			["skills.state", { workspaceId: "workspace" }],
		] as const) {
			const entries = (await handleRequest(method, params, ctx)) as { name: string }[];
			expect(
				entries.some(
					(entry) => entry.name === (method === "skill.list" ? "skill:librarian" : "librarian"),
				),
			).toBe(false);
			expect(
				entries.some(
					(entry) =>
						entry.name ===
						(method === "skill.list" ? "skill:choosing-a-workflow" : "choosing-a-workflow"),
				),
			).toBe(true);
		}
	}
});

test("child settings persist through their real routes with bounded concurrency and reset semantics", async () => {
	await handleRequest("workspace.setSubagentsOverride", { id: "workspace", override: "off" }, ctx);
	await handleRequest("workspace.setSubagentMaxConcurrent", { id: "workspace", value: 3 }, ctx);
	expect(getWorkspace("workspace")).toMatchObject({
		subagentsOverride: "off",
		subagentMaxConcurrentOverride: 3,
	});
	await expect(
		handleRequest("workspace.setSubagentMaxConcurrent", { id: "workspace", value: 17 }, ctx),
	).rejects.toThrow("1 to 16");
	await handleRequest("workspace.setSubagentsOverride", { id: "workspace", override: null }, ctx);
	await handleRequest("workspace.setSubagentMaxConcurrent", { id: "workspace", value: null }, ctx);
	expect(getWorkspace("workspace").subagentsOverride).toBeUndefined();
	expect(getWorkspace("workspace").subagentMaxConcurrentOverride).toBeUndefined();
});

test("login reply/cancel only accept owned MCP flows after removing Pi provider login", async () => {
	for (const method of ["provider.loginReply", "provider.loginCancel"]) {
		await expect(
			handleRequest(method, { loginId: "old-provider-flow", value: "secret" }, ctx),
		).rejects.toThrow("Unknown MCP login");
	}
});

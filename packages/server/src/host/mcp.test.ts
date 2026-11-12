import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginPush, McpListResult, McpServerSummary } from "@thinkrail/contracts";
import {
	cancelAllMcpProbes,
	closeAllMcpConnections,
	createSession,
	disposeAllSessions,
	fingerprintMcpEntry,
	refreshMcpStatus,
	setMcpLoginPublisher,
	setMcpProjectResolver,
	setMcpStatusPublisher,
} from "../agent";
import { startOAuthMcpFixture } from "../agent/mcp/fixtures/oauthServer";
import { saveProjects, saveWorkspaces } from "../persistence";
import { getProjects, setProjectTrust } from "../projects";
import { stopAllWatches } from "../watch";
import {
	mcpAdd,
	mcpApprove,
	mcpList,
	mcpLogin,
	mcpRemove,
	mcpUpdate,
	reloadLiveSessions,
} from "./mcp";

let root: string;
let repo: string;
let previousData: string | undefined;
let fixture: ReturnType<typeof startOAuthMcpFixture> | undefined;
const frames: LoginPush[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "host-sdk-mcp-"));
	repo = join(root, "repo");
	mkdirSync(repo);
	previousData = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	mkdirSync(process.env.THINKRAIL_DATA_DIR);
	saveProjects([
		{
			id: "project",
			name: "Repo",
			path: repo,
			slug: "repo",
			lastOpened: 1,
			trusted: true,
			resourceTrust: "granted",
		},
	]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			kind: "default",
			name: "Repo",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
		},
	]);
	setMcpProjectResolver(() => getProjects().find((project) => project.id === "project"));
	frames.length = 0;
	setMcpLoginPublisher((push) => frames.push(push));
});
afterEach(async () => {
	await cancelAllMcpProbes();
	await closeAllMcpConnections();
	disposeAllSessions();
	stopAllWatches();
	setMcpProjectResolver(undefined);
	setMcpStatusPublisher(() => {});
	setMcpLoginPublisher(() => {});
	fixture?.stop();
	fixture = undefined;
	if (previousData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previousData;
	rmSync(root, { recursive: true, force: true });
});
const row = (result: McpListResult, scope: McpServerSummary["scope"], name: string) =>
	result.servers.find((server) => server.scope === scope && server.name === name);
function fingerprint(
	result: McpListResult,
	scope: McpServerSummary["scope"],
	name: string,
): string {
	const value = row(result, scope, name)?.fingerprint;
	if (!value) throw new Error("Missing server fingerprint.");
	return value;
}
function stdio(pidFile?: string) {
	return {
		command: process.execPath,
		args: [join(import.meta.dir, "../agent/mcp/fixtures/stdioServer.ts")],
		...(pidFile ? { env: { MCP_FIXTURE_PID_FILE: pidFile } } : {}),
	};
}
async function authUrl(): Promise<URL> {
	for (
		let attempt = 0;
		attempt < 150 && !frames.some((push) => push.frame.kind === "authUrl");
		attempt++
	)
		await Bun.sleep(10);
	const frame = frames.find((push) => push.frame.kind === "authUrl")?.frame;
	if (frame?.kind !== "authUrl") throw new Error(`No authorization URL: ${JSON.stringify(frames)}`);
	return new URL(frame.url);
}
test("real MCP management retains the rendered fingerprint for update/remove and preserves the file after stale requests", async () => {
	const added = await mcpAdd({
		workspaceId: "workspace",
		scope: "user",
		name: "docs",
		entry: { url: "https://docs.example/mcp" },
	});
	const first = fingerprint(added, "user", "docs");
	const path = join(root, "data/mcp.json");
	writeFileSync(
		path,
		JSON.stringify({ mcpServers: { docs: { url: "https://changed.example/mcp" } } }),
	);
	const before = readFileSync(path, "utf8");
	const stale = {
		workspaceId: "workspace",
		scope: "user" as const,
		name: "docs",
		expectedFingerprint: first,
	};
	await expect(mcpUpdate({ ...stale, entry: { url: "https://new.example/mcp" } })).rejects.toThrow(
		"changed since",
	);
	await expect(mcpRemove(stale)).rejects.toThrow("changed since");
	expect(readFileSync(path, "utf8")).toBe(before);
	const current = fingerprint(await mcpList({ workspaceId: "workspace" }), "user", "docs");
	const updated = await mcpUpdate({
		...stale,
		expectedFingerprint: current,
		entry: { url: "https://new.example/mcp" },
	});
	expect(row(updated, "user", "docs")?.endpoint).toBe("https://new.example/mcp");
	await mcpRemove({ ...stale, expectedFingerprint: fingerprint(updated, "user", "docs") });
	expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.docs).toBeUndefined();
});
test("project config writes require current resource trust and approvals admit exactly the reviewed entry", async () => {
	setProjectTrust("project", false);
	await expect(
		mcpAdd({ workspaceId: "workspace", scope: "project", name: "docs", entry: stdio() }),
	).rejects.toThrow("isn't trusted");
	expect(existsSync(join(repo, ".raildesign/mcp.json"))).toBe(false);
	setProjectTrust("project", true, undefined, { resources: true });
	mkdirSync(join(repo, ".raildesign"));
	const path = join(repo, ".raildesign/mcp.json");
	const config = stdio();
	writeFileSync(path, JSON.stringify({ mcpServers: { docs: config } }));
	const pending = await mcpList({ workspaceId: "workspace" });
	expect(row(pending, "project", "docs")?.approval?.state).toBe("pending");
	const first = fingerprint(pending, "project", "docs");
	writeFileSync(
		path,
		JSON.stringify({ mcpServers: { docs: { ...config, args: [...config.args, "changed"] } } }),
	);
	await expect(
		mcpApprove({ workspaceId: "workspace", name: "docs", fingerprint: first }),
	).rejects.toThrow("changed since");
	const current = fingerprint(await mcpList({ workspaceId: "workspace" }), "project", "docs");
	const approved = await mcpApprove({
		workspaceId: "workspace",
		name: "docs",
		fingerprint: current,
	});
	expect(row(approved, "project", "docs")?.approval?.state).toBe("approved");
	expect(getProjects()[0]?.mcpApprovals?.docs).toBe(current);
	expect(current).not.toBe(fingerprintMcpEntry("docs", config));
});
test("a config mutation cancels the old OAuth callback and closes its SDK subprocess before publishing the replacement connection", async () => {
	fixture = startOAuthMcpFixture();
	const pidFile = join(root, "pid");
	const stdioConfig = stdio(pidFile);
	writeFileSync(
		join(root, "data/mcp.json"),
		JSON.stringify({ mcpServers: { local: stdioConfig, remote: { url: fixture.url } } }),
	);
	const { sessionId } = await createSession({
		workspaceId: "workspace",
		cwd: repo,
		modelOptional: true,
	});
	const initial = await mcpList({ workspaceId: "workspace" });
	expect(initial.statuses[0]?.servers.find((server) => server.name === "local")?.state).toBe(
		"connected",
	);
	const oldPid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(oldPid) && oldPid > 0).toBe(true);
	await mcpLogin({ workspaceId: "workspace", name: "remote" }, "owner");
	const auth = await authUrl();
	let replacementPublished = false;
	let oldProcessAliveAtReplacement = true;
	let probeFrameAtReplacement: string | undefined;
	setMcpStatusPublisher((snapshot) => {
		if (snapshot.servers.find((server) => server.name === "local")?.state === "disabled") {
			replacementPublished = true;
			try {
				process.kill(oldPid, 0);
			} catch {
				oldProcessAliveAtReplacement = false;
			}
			probeFrameAtReplacement = frames.at(-1)?.frame.kind;
		}
	});
	await mcpUpdate({
		workspaceId: "workspace",
		scope: "user",
		name: "local",
		expectedFingerprint: fingerprint(initial, "user", "local"),
		entry: { ...stdioConfig, enabled: false },
	});
	expect(replacementPublished).toBe(true);
	expect(oldProcessAliveAtReplacement).toBe(false);
	expect(probeFrameAtReplacement).toBe("error");
	await expect(fetch(auth.searchParams.get("redirect_uri") ?? "")).rejects.toBeDefined();
	expect(fixture.tokenRequests()).toBe(0);
	expect(
		(await refreshMcpStatus(sessionId, 1000))?.servers.find((server) => server.name === "local")
			?.state,
	).toBe("disabled");
});
test("revoking project trust cancels OAuth and closes the formerly approved stdio connection before reconciliation returns", async () => {
	fixture = startOAuthMcpFixture();
	const pidFile = join(root, "pid");
	await mcpAdd({
		workspaceId: "workspace",
		scope: "project",
		name: "local",
		entry: stdio(pidFile),
	});
	await mcpAdd({
		workspaceId: "workspace",
		scope: "project",
		name: "remote",
		entry: { url: fixture.url },
	});
	const { sessionId } = await createSession({
		workspaceId: "workspace",
		cwd: repo,
		modelOptional: true,
	});
	await mcpList({ workspaceId: "workspace" });
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	await mcpLogin({ workspaceId: "workspace", name: "remote" }, "owner");
	await authUrl();
	setProjectTrust("project", false);
	await reloadLiveSessions(["workspace"]);
	expect(() => process.kill(pid, 0)).toThrow();
	expect(frames.at(-1)?.frame.kind).toBe("error");
	expect((await refreshMcpStatus(sessionId, 1000))?.servers).toEqual([]);
	expect(fixture.tokenRequests()).toBe(0);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpStatusSnapshot, Project } from "@thinkrail/contracts";
import { saveWorkspaces } from "../persistence";
import { fingerprintMcpEntry } from "./mcp";
import { LoggedStdioMcpServer } from "./mcp/stdio";
import {
	closeAllMcpConnections,
	closeSessionMcpConnections,
	closeWorkspaceMcpConnections,
	listMcpServers,
	readMcpToolOutput,
	reconcileMcpSessions,
	refreshMcpStatus,
	setMcpProjectResolver,
	setMcpStatusPublisher,
	setSessionMcpServerEnabled,
	storeMcpToolOutput,
	watchUserMcpConfig,
} from "./mcpSessions";
import { createSession, disposeAllSessions, ensureSessionAttached } from "./sdkSessionManager";
import { readSessionRecord, writeSessionRecord } from "./sessionStore";

let root: string;
let cwd: string;
let sessionId: string;
let previous: string | undefined;
const snapshots: McpStatusSnapshot[] = [];
type Policy = Pick<Project, "resourceTrust" | "mcpApprovals" | "mcpOverrides" | "mcpToolGrants">;
let policy: Policy | undefined;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sdk-mcp-sessions-"));
	cwd = join(root, "workspace");
	mkdirSync(cwd);
	previous = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	mkdirSync(process.env.THINKRAIL_DATA_DIR);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "main",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	({ sessionId } = await createSession({ workspaceId: "workspace", cwd, modelOptional: true }));
	policy = undefined;
	setMcpProjectResolver(() => policy);
	snapshots.length = 0;
	setMcpStatusPublisher((snapshot) => snapshots.push(snapshot));
});
afterEach(async () => {
	await closeAllMcpConnections();
	disposeAllSessions();
	setMcpStatusPublisher(() => {});
	setMcpProjectResolver(undefined);
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});
function entry(pidFile?: string) {
	return {
		command: process.execPath,
		args: [join(import.meta.dir, "mcp/fixtures/stdioServer.ts")],
		...(pidFile ? { env: { MCP_FIXTURE_PID_FILE: pidFile } } : {}),
	};
}
test("settings status uses real SDK connections and chat disable survives configuration reconciliation", async () => {
	writeFileSync(join(root, "data/mcp.json"), JSON.stringify({ mcpServers: { docs: entry() } }));
	const result = await listMcpServers({
		workspaceId: "workspace",
		cwd,
		project: undefined,
		waitMs: 1000,
	});
	expect(result.servers[0]).toMatchObject({ name: "docs", effective: true });
	expect(result.statuses[0]?.servers[0]).toMatchObject({
		name: "docs",
		state: "connected",
		toolCount: 4,
	});
	await setSessionMcpServerEnabled(sessionId, "docs", false);
	expect((await refreshMcpStatus(sessionId, 1000))?.servers[0]?.state).toBe("disabled-in-chat");
	await closeWorkspaceMcpConnections("workspace");
	await reconcileMcpSessions([sessionId]);
	expect((await refreshMcpStatus(sessionId, 1000))?.servers[0]?.state).toBe("disabled-in-chat");
	await setSessionMcpServerEnabled(sessionId, "docs", true);
	expect((await refreshMcpStatus(sessionId, 1000))?.servers[0]?.state).toBe("connected");
	expect(
		snapshots.every(
			(snapshot, index) =>
				index === 0 || snapshot.generation > (snapshots[index - 1]?.generation ?? 0),
		),
	).toBe(true);
});

test("the owned user config watcher reloads actual transports after an external edit", async () => {
	const pidFile = join(root, "watched-pid");
	const config = entry(pidFile);
	const path = join(root, "data/mcp.json");
	writeFileSync(path, JSON.stringify({ mcpServers: { docs: config } }));
	await refreshMcpStatus(sessionId, 1000);
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	const stop = watchUserMcpConfig();
	try {
		writeFileSync(path, JSON.stringify({ mcpServers: { docs: { ...config, enabled: false } } }));
		for (
			let attempt = 0;
			attempt < 150 && snapshots.at(-1)?.servers[0]?.state !== "disabled";
			attempt++
		)
			await Bun.sleep(10);
		expect(snapshots.at(-1)?.servers[0]?.state).toBe("disabled");
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await stop();
	}
});
test("concurrent session close and host shutdown await the same held public SDK cleanup", async () => {
	const pidFile = join(root, "held-pid");
	const config = entry(pidFile);
	writeFileSync(join(root, "data/mcp.json"), JSON.stringify({ mcpServers: { docs: config } }));
	expect((await refreshMcpStatus(sessionId, 1000))?.servers[0]).toMatchObject({
		state: "connected",
	});
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	const realClose = LoggedStdioMcpServer.prototype.close;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	LoggedStdioMcpServer.prototype.close = async function () {
		await held;
		await realClose.call(this);
	};
	try {
		const first = closeSessionMcpConnections(sessionId);
		const second = closeSessionMcpConnections(sessionId);
		expect(second).toBe(first);
		expect(await refreshMcpStatus(sessionId, 0)).toBeNull();
		let shutdownFinished = false;
		const shutdown = closeAllMcpConnections().then(() => {
			shutdownFinished = true;
		});
		await Bun.sleep(20);
		expect(shutdownFinished).toBe(false);
		expect(readFileSync(pidFile, "utf8").trim().split(/\s+/)).toHaveLength(1);
		release();
		await Promise.all([first, second, shutdown]);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		release();
		LoggedStdioMcpServer.prototype.close = realClose;
	}
}, 10_000);
test("stopping the config watcher drains a reload already waiting for SDK cleanup", async () => {
	const config = entry();
	const path = join(root, "data/mcp.json");
	writeFileSync(path, JSON.stringify({ mcpServers: { docs: config } }));
	await refreshMcpStatus(sessionId, 1000);
	const realClose = LoggedStdioMcpServer.prototype.close;
	let started = false;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	LoggedStdioMcpServer.prototype.close = async function () {
		started = true;
		await held;
		await realClose.call(this);
	};
	const stop = watchUserMcpConfig();
	try {
		writeFileSync(path, JSON.stringify({ mcpServers: { docs: { ...config, enabled: false } } }));
		for (let attempt = 0; attempt < 150 && !started; attempt++) await Bun.sleep(10);
		expect(started).toBe(true);
		let stopped = false;
		const stopping = stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(20);
		expect(stopped).toBe(false);
		release();
		await stopping;
		expect(stopped).toBe(true);
	} finally {
		release();
		await stop();
		LoggedStdioMcpServer.prototype.close = realClose;
	}
});
test("project entries require current resource trust and exact fingerprint; revocation closes the process before reload", async () => {
	const pidFile = join(root, "pid");
	const config = entry(pidFile);
	mkdirSync(join(cwd, ".raildesign"));
	writeFileSync(
		join(cwd, ".raildesign/mcp.json"),
		JSON.stringify({ mcpServers: { docs: config } }),
	);
	policy = { resourceTrust: "granted", mcpApprovals: { docs: "stale" } };
	expect(
		(await listMcpServers({ workspaceId: "workspace", cwd, project: policy, waitMs: 1000 }))
			.statuses[0]?.servers[0]?.state,
	).toBe("pending-approval");
	expect(existsSync(pidFile)).toBe(false);
	policy.mcpApprovals = { docs: fingerprintMcpEntry("docs", config) };
	await reconcileMcpSessions([sessionId]);
	expect((await refreshMcpStatus(sessionId, 1000))?.servers[0]?.state).toBe("connected");
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	policy = { ...policy, resourceTrust: "untrusted" };
	await closeWorkspaceMcpConnections("workspace");
	expect(() => process.kill(pid, 0)).toThrow();
	await reconcileMcpSessions([sessionId]);
	expect((await refreshMcpStatus(sessionId, 1000))?.servers).toEqual([]);
});
test("full output is owned by the current SDK transcript and selected workspace, bounded, and cannot use arbitrary transcript paths", async () => {
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("No session record.");
	record.messages.push({
		role: "toolResult",
		toolCallId: "mcp-call",
		toolName: "mcp__docs__big",
		content: [{ type: "text", text: "truncated" }],
		isError: false,
		timestamp: Date.now(),
	});
	writeSessionRecord(record);
	disposeAllSessions();
	await ensureSessionAttached(sessionId, "workspace", cwd);
	const full = "x".repeat(1024 * 1024 + 20);
	storeMcpToolOutput(sessionId, "mcp-call", full);
	const result = await readMcpToolOutput("workspace", sessionId, "mcp-call", cwd);
	expect(result).toMatchObject({ available: true, truncated: true });
	if (result.available) expect(result.text.length).toBe(1024 * 1024);
	expect(await readMcpToolOutput("workspace", sessionId, "not-a-tool", cwd)).toEqual({
		available: false,
		reason: "unavailable",
	});
	await expect(readMcpToolOutput("other", sessionId, "mcp-call", cwd)).rejects.toThrow();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsMethodName, WsParams, WsResult } from "@thinkrail/contracts";
import { writeHermeticE2eShell } from "../e2e/fixtures/executables";
import { disposeFixtureResources } from "../e2e/fixtures/resourceCleanup";
import { handleRequest } from "../packages/server/src/host/handlers";
import { saveWorkspaces } from "../packages/server/src/persistence";
import { resetTerminalState } from "../packages/server/src/terminal";

const posix = test.skipIf(process.platform === "win32");
const saved = Object.fromEntries(
	["THINKRAIL_DATA_DIR", "SHELL", "HOME", "USERPROFILE", "HISTFILE", "ZDOTDIR"].map((key) => [
		key,
		process.env[key],
	]),
);
let directory: string;
let worktree: string;
const ownedPids: number[] = [];
const wire = {
	async request<M extends WsMethodName>(method: M, params: WsParams<M>): Promise<WsResult<M>> {
		return (await handleRequest(method, params, { clientKey: "fixture-cleanup" })) as WsResult<M>;
	},
};
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error("The owned terminal did not reach its expected state");
		await Bun.sleep(5);
	}
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "raildesign-e2e-cleanup-"));
	worktree = join(directory, "worktree");
	const home = join(directory, "home");
	const bin = join(directory, "bin");
	for (const path of [worktree, home, bin]) mkdirSync(path);
	writeHermeticE2eShell(bin, "/bin/sh");
	process.env.THINKRAIL_DATA_DIR = directory;
	process.env.SHELL = join(bin, "login-shell");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.HISTFILE = join(home, ".history");
	process.env.ZDOTDIR = home;
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Owned PTYs",
			branch: "main",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
});
afterEach(async () => {
	resetTerminalState();
	await until(() => ownedPids.every((pid) => !alive(pid)));
	ownedPids.length = 0;
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(directory, { recursive: true, force: true });
});
async function openOwnedTerminal(tabKey: string): Promise<number> {
	const { id } = await wire.request("terminal.attach", { workspaceId: "workspace", tabKey });
	const file = join(worktree, `${tabKey}.pid`);
	await wire.request("terminal.write", { id, data: `printf '%s' $$ > ${tabKey}.pid\r` });
	await until(() => existsSync(file));
	const pid = Number(readFileSync(file, "utf8"));
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The shell did not publish its PID");
	ownedPids.push(pid);
	return pid;
}

posix(
	"fixture cleanup releases PTYs even without agent sessions or surviving workspace files",
	async () => {
		for (let i = 0; i < 3; i += 1) await openOwnedTerminal(`owned-${i}`);
		expect(existsSync(join(directory, "sessions"))).toBe(false);
		saveWorkspaces([]);
		rmSync(worktree, { recursive: true, force: true });
		expect(ownedPids.every(alive)).toBe(true);
		expect(existsSync(process.env.SHELL ?? "")).toBe(true);
		await disposeFixtureResources(directory, wire);
		await until(() => ownedPids.every((pid) => !alive(pid)));
		expect(await wire.request("terminal.list", { workspaceId: "workspace" })).toEqual({ tabs: [] });
		expect(JSON.parse(readFileSync(join(directory, "terminals.json"), "utf8"))).toEqual({});
	},
);

posix("a failed terminal cleanup rejects before reset can remove workspace state", async () => {
	const pid = await openOwnedTerminal("retained");
	const file = join(directory, "workspaces.json");
	const before = readFileSync(file, "utf8");
	const rejected = {
		async request<M extends WsMethodName>(method: M, params: WsParams<M>): Promise<WsResult<M>> {
			if (method === "terminal.close") throw new Error("Owned terminal cleanup failed");
			return wire.request(method, params);
		},
	};
	await expect(disposeFixtureResources(directory, rejected)).rejects.toThrow(
		"Owned terminal cleanup failed",
	);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(alive(pid)).toBe(true);
	await disposeFixtureResources(directory, wire);
	await until(() => !alive(pid));
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginPush } from "@thinkrail/contracts";
import { unlockSync } from "proper-lockfile";
import {
	createSession,
	mcpPolicyOf,
	setMcpLoginPublisher,
	setSessionResourceCleanup,
	startMcpProbe,
} from "../agent";
import { startOAuthMcpFixture } from "../agent/mcp/fixtures/oauthServer";
import { saveProjects, saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { handleRequest } from "./handlers";
import { createServer, type RunningServer } from "./server";

let root: string;
let worktree: string;
let server: RunningServer | undefined;
const savedData = process.env.THINKRAIL_DATA_DIR;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-mcp-lifecycle-"));
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	worktree = join(root, "repo");
	mkdirSync(worktree);
	saveProjects([{ id: "project", name: "Test", path: worktree, slug: "test", lastOpened: 1 }]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "main",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
	resetConfigCache();
});
afterEach(async () => {
	await server?.shutdown().catch(() => {});
	setSessionResourceCleanup(undefined);
	setMcpLoginPublisher(() => {});
	resetConfigCache();
	if (savedData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedData;
	rmSync(root, { recursive: true, force: true });
	server = undefined;
});

test("shutdown rejects new requests and keeps writer ownership until session resource cleanup settles", async () => {
	server = await createServer({ port: 0, host: "127.0.0.1" });
	await createSession({ cwd: worktree, workspaceId: "workspace", modelOptional: true });
	let finish = () => {};
	setSessionResourceCleanup(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const closing = server.shutdown();
	expect(server.shutdown()).toBe(closing);
	await Bun.sleep(0);
	expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(503);
	await expect(createServer({ port: 0 })).rejects.toMatchObject({ code: "ELOCKED" });
	finish();
	await closing;
	server = await createServer({ port: 0, host: "127.0.0.1" });
	expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
});

test("failed cleanup is reported and cannot release writer ownership", async () => {
	server = await createServer({ port: 0 });
	await createSession({ cwd: worktree, workspaceId: "workspace", modelOptional: true });
	setSessionResourceCleanup(async () => {
		throw new Error("resource still active");
	});
	await expect(server.shutdown()).rejects.toThrow("Host resource cleanup failed");
	await expect(createServer({ port: 0 })).rejects.toMatchObject({ code: "ELOCKED" });
	// The fixture owns this failed host; release its retained test lock before removing the directory.
	unlockSync(join(root, "data"), { lockfilePath: join(root, "data", "host.lock") });
});

test.each(["shutdown", "project.close", "workspace.remove"] as const)(
	"%s cancels OAuth without a live session and closes its callback listener before returning",
	async (operation) => {
		const fixture = startOAuthMcpFixture();
		try {
			writeFileSync(
				join(root, "data", "mcp.json"),
				JSON.stringify({ mcpServers: { docs: { url: fixture.url } } }),
			);
			server = await createServer({ port: 0 });
			const pushes: LoginPush[] = [];
			setMcpLoginPublisher((push) => pushes.push(push));
			const login = startMcpProbe({
				action: "login",
				workspaceId: "workspace",
				cwd: worktree,
				projectTrusted: false,
				policy: mcpPolicyOf(undefined),
				serverName: "docs",
				ownerClientKey: "owner",
				deadlineMs: 3000,
			});
			for (let i = 0; i < 150 && !pushes.some((push) => push.frame.kind === "authUrl"); i++)
				await Bun.sleep(10);
			const frame = pushes.find((push) => push.frame.kind === "authUrl")?.frame;
			if (frame?.kind !== "authUrl") throw new Error("No authorization URL");
			const callback = new URL(new URL(frame.url).searchParams.get("redirect_uri") ?? "");
			if (operation === "shutdown") await server.shutdown();
			else
				await handleRequest(
					operation,
					{ id: operation === "project.close" ? "project" : "workspace" },
					{ clientKey: "owner" },
				);
			expect((await login.done).kind).toBe("error");
			await expect(fetch(callback)).rejects.toThrow();
			if (operation === "shutdown") server = await createServer({ port: 0 });
		} finally {
			fixture.stop();
		}
	},
);

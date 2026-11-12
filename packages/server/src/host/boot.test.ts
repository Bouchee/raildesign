import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HostUpdateNotice,
	ServerWelcome,
	WorkspaceFsChangedPayload,
} from "@thinkrail/contracts";
import { PROTOCOL_VERSION, WS_CHANNELS, WS_MAX_FRAME_BYTES } from "@thinkrail/contracts";
import { isPortFree } from "@thinkrail/shared/freePort";
import { resetConfigCache } from "../settings";
import { type BootedHost, bootHost } from "./boot";
import { handleRequest } from "./handlers";

process.setMaxListeners(50);

const booted: BootedHost[] = [];
const tmpDirs: string[] = [];
const originalDataDir = process.env.THINKRAIL_DATA_DIR;
const SHELL_ENV_KEYS = [
	Symbol.for("raildesign.shellEnv.launchKeys"),
	Symbol.for("raildesign.shellEnv.pending"),
];
const processState = globalThis as Record<symbol, unknown>;
let originalShellEnv: Map<symbol, unknown>;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

interface SocketFrame {
	channel?: string;
	data?: unknown;
	id?: string;
	ok?: boolean;
}

interface SocketCollector {
	socket: WebSocket;
	frames: SocketFrame[];
	waitForFrame(matches: (frame: SocketFrame) => boolean): Promise<SocketFrame>;
}

interface CheckHarness<T> {
	checks: Deferred<T>[];
	check(): Promise<T>;
	waitForCheck(index: number): Promise<Deferred<T>>;
}

function deferred<T>(): Deferred<T> {
	let resolve = (_value: T): void => {};
	let reject = (_error: unknown): void => {};
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function createCheckHarness<T>(): CheckHarness<T> {
	const checks: Deferred<T>[] = [];
	const waiters = new Map<number, (check: Deferred<T>) => void>();
	return {
		checks,
		check: () => {
			const pending = deferred<T>();
			const index = checks.push(pending) - 1;
			waiters.get(index)?.(pending);
			waiters.delete(index);
			return pending.promise;
		},
		waitForCheck: (index) => {
			const pending = checks[index];
			if (pending) return Promise.resolve(pending);
			return new Promise<Deferred<T>>((resolve) => waiters.set(index, resolve));
		},
	};
}

async function collectSocket(port: number, client: string): Promise<SocketCollector> {
	const socket = new WebSocket(
		`ws://localhost:${port}/ws?client=${client}&protocol=${PROTOCOL_VERSION}`,
	);
	const frames: SocketFrame[] = [];
	const waiters = new Set<{
		matches: (frame: SocketFrame) => boolean;
		resolve(frame: SocketFrame): void;
	}>();
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as SocketFrame;
		frames.push(frame);
		for (const waiter of waiters) {
			if (!waiter.matches(frame)) continue;
			waiters.delete(waiter);
			waiter.resolve(frame);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("websocket failed to open")), {
			once: true,
		});
	});
	return {
		socket,
		frames,
		waitForFrame: (matches) => {
			const frame = frames.find(matches);
			if (frame) return Promise.resolve(frame);
			return new Promise<SocketFrame>((resolve) => waiters.add({ matches, resolve }));
		},
	};
}

async function socketBarrier(collector: SocketCollector, id: string): Promise<void> {
	collector.socket.send(JSON.stringify({ id, method: "project.list", params: {} }));
	const frame = await collector.waitForFrame((candidate) => candidate.id === id);
	expect(frame.ok).toBe(true);
}

beforeEach(async () => {
	originalShellEnv = new Map(SHELL_ENV_KEYS.map((key) => [key, processState[key]]));
	for (const key of SHELL_ENV_KEYS) delete processState[key];
	resetConfigCache();
	const dir = mkdtempSync(join(tmpdir(), "thinkrail-boot-data-"));
	tmpDirs.push(dir);
	process.env.THINKRAIL_DATA_DIR = dir;
});

afterEach(async () => {
	while (booted.length) await booted.pop()?.server.shutdown();
	for (const [key, value] of originalShellEnv) {
		if (value === undefined) delete processState[key];
		else processState[key] = value;
	}
	resetConfigCache();
	while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = originalDataDir;
});

function grabFreePort(): number {
	const probe = Bun.serve({ port: 0, hostname: "localhost", fetch: () => new Response("x") });
	const port = probe.port;
	if (port == null) throw new Error("probe failed to bind");
	probe.stop(true);
	return port;
}

async function boot(options: Parameters<typeof bootHost>[0]): Promise<BootedHost> {
	const b = await bootHost(options);
	booted.push(b);
	return b;
}

test("boot applies the stored environment before serving, and launch variables win", async () => {
	const dir = process.env.THINKRAIL_DATA_DIR;
	if (!dir) throw new Error("missing fixture data directory");
	process.env.TR_BOOT_LAUNCH = "launch";
	writeFileSync(
		join(dir, "environment.json"),
		JSON.stringify({
			vars: [
				{ name: "TR_BOOT_STORED", value: "stored" },
				{ name: "TR_BOOT_LAUNCH", value: "stored" },
				{ name: "THINKRAIL_PORT", value: "1" },
			],
		}),
	);
	try {
		await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
		expect(process.env.TR_BOOT_STORED).toBe("stored");
		expect(process.env.TR_BOOT_LAUNCH).toBe("launch");
		expect(process.env.THINKRAIL_PORT).toBeUndefined();
		const status = await handleRequest("environment.get", {}, { clientKey: "client" });
		expect(status).toMatchObject({
			restartRequired: false,
			launchOverridden: ["TR_BOOT_LAUNCH"],
		});
	} finally {
		delete process.env.TR_BOOT_STORED;
		delete process.env.TR_BOOT_LAUNCH;
	}
});

test('portMode "exact" binds the requested port', async () => {
	const requested = grabFreePort();
	const b = await boot({ port: requested, host: "localhost", portMode: "exact" });

	expect(b.requested).toBe(requested);
	expect(b.port).toBe(requested);
	expect(b.server.port).toBe(requested);
	const res = await fetch(`http://localhost:${b.port}/health`);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ok");
});

test('portMode "free" scans upward past a taken port', async () => {
	const holder = Bun.serve({ port: 0, hostname: "localhost", fetch: () => new Response("x") });
	const taken = holder.port as number;
	try {
		const b = await boot({ port: taken, host: "localhost", portMode: "free" });
		expect(b.requested).toBe(taken);
		expect(b.port).toBeGreaterThan(taken);
		const res = await fetch(`http://localhost:${b.port}/health`);
		expect(await res.text()).toBe("ok");
	} finally {
		holder.stop(true);
	}
});

test("serves the SPA from staticDir with index.html fallback", async () => {
	const dir = mkdtempSync(join(tmpdir(), "thinkrail-boot-"));
	tmpDirs.push(dir);
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");

	const b = await boot({
		port: grabFreePort(),
		host: "localhost",
		portMode: "exact",
		staticDir: dir,
	});

	const root = await fetch(`http://localhost:${b.port}/`);
	expect(root.status).toBe(200);
	expect(root.headers.get("content-type") ?? "").toContain("text/html");
	expect(await root.text()).toContain("<title>spa</title>");

	const deep = await fetch(`http://localhost:${b.port}/some/client/route`);
	expect(deep.status).toBe(200);
	expect(await deep.text()).toContain("<title>spa</title>");
});

test("stop() releases the port", async () => {
	const b = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
	expect(await isPortFree(b.port)).toBe(false);
	b.server.stop();
	expect(await isPortFree(b.port)).toBe(true);
});

test("boot refuses a second writer and releases ownership after shutdown", async () => {
	const first = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
	await expect(
		boot({ port: grabFreePort(), host: "localhost", portMode: "exact" }),
	).rejects.toMatchObject({ code: "ELOCKED" });
	expect(await (await fetch(`http://localhost:${first.port}/health`)).text()).toBe("ok");
	await first.server.shutdown();
	const replacement = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
	expect(await (await fetch(`http://localhost:${replacement.port}/health`)).text()).toBe("ok");
});

test("a bind failure releases ownership before the next startup", async () => {
	const holder = createTcpServer();
	await new Promise<void>((resolve) =>
		holder.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve),
	);
	const address = holder.address();
	if (!address || typeof address === "string") throw new Error("Missing TCP fixture address");
	try {
		await expect(
			boot({ port: address.port, host: "127.0.0.1", portMode: "exact" }),
		).rejects.toThrow();
		const recovered = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
		expect(await (await fetch(`http://localhost:${recovered.port}/health`)).text()).toBe("ok");
	} finally {
		await new Promise<void>((resolve, reject) =>
			holder.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
test("welcome omits closed projects whose folders are gone", async () => {
	const dir = process.env.THINKRAIL_DATA_DIR;
	if (!dir) throw new Error("missing fixture data directory");
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify([
			{ id: "open", name: "open", path: join(dir, "unplugged"), slug: "open", lastOpened: 3 },
			{
				id: "gone",
				name: "gone",
				path: join(dir, "gone"),
				slug: "gone",
				lastOpened: 2,
				closed: true,
			},
			{ id: "kept", name: "kept", path: dir, slug: "kept", lastOpened: 1, closed: true },
		]),
	);
	const b = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
	const collector = await collectSocket(b.port, "recents");
	const frame = await collector.waitForFrame(
		(candidate) => candidate.channel === WS_CHANNELS.serverWelcome,
	);

	const welcome = frame.data as ServerWelcome;
	expect(welcome.projects.filter((project) => project.kind !== "chats").map((p) => p.id)).toEqual([
		"open",
	]);
	expect(welcome.projects.filter((project) => project.kind === "chats")).toHaveLength(1);
	expect(welcome.recentProjects?.map((project) => project.id)).toEqual(["open", "kept"]);
});

test.if(process.platform === "linux")(
	"on Linux a project skill under a git-ignored folder still reports a skill change",
	async () => {
		const dir = process.env.THINKRAIL_DATA_DIR;
		if (!dir) throw new Error("missing fixture data directory");
		const worktree = join(dir, "repo");
		const skill = join(worktree, ".claude", "skills", "demo", "SKILL.md");
		const venv = join(worktree, ".claude", "skills", "demo", ".venv");
		mkdirSync(venv, { recursive: true });
		expect(Bun.spawnSync(["git", "init", "-q", worktree]).success).toBe(true);
		writeFileSync(join(worktree, ".gitignore"), ".claude/\ntmp/\n");
		mkdirSync(join(worktree, "tmp"));
		writeFileSync(skill, "v1\n");
		writeFileSync(
			join(dir, "workspaces.json"),
			JSON.stringify([
				{
					id: "skills",
					projectId: "p",
					name: "skills",
					branch: "main",
					worktreePath: worktree,
					baseBranch: "main",
				},
			]),
		);
		const b = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
		const collector = await collectSocket(b.port, "skills");
		collector.socket.send(
			JSON.stringify({
				id: "ready",
				method: "workspace.watchReady",
				params: { workspaceId: "skills" },
			}),
		);
		expect((await collector.waitForFrame((frame) => frame.id === "ready")).ok).toBe(true);
		writeFileSync(join(worktree, "tmp", "out.txt"), "x\n");
		writeFileSync(join(venv, "out.txt"), "x\n");
		writeFileSync(skill, "v2\n");
		await collector.waitForFrame(
			(frame) =>
				frame.channel === WS_CHANNELS.workspaceFsChanged &&
				(frame.data as WorkspaceFsChangedPayload).skillChange === "detected",
		);
		const paths = collector.frames.flatMap((frame) =>
			frame.channel === WS_CHANNELS.workspaceFsChanged
				? (frame.data as WorkspaceFsChangedPayload).paths
				: [],
		);
		expect(paths.filter((path) => path.startsWith("tmp/") || path.includes("/.venv/"))).toEqual([]);
	},
);

test.if(process.platform === "linux")(
	"on Linux a doc in a subfolder of the git-ignored scratch dir still sends an event",
	async () => {
		const dir = process.env.THINKRAIL_DATA_DIR;
		if (!dir) throw new Error("missing fixture data directory");
		const worktree = join(dir, "repo");
		const scratch = join(worktree, ".raildesign", "context");
		mkdirSync(join(scratch, "topic"), { recursive: true });
		expect(Bun.spawnSync(["git", "init", "-q", worktree]).success).toBe(true);
		writeFileSync(join(worktree, ".gitignore"), ".raildesign/\n");
		writeFileSync(join(scratch, ".gitignore"), "*\n");
		writeFileSync(join(scratch, "topic", "doc.md"), "v1\n");
		writeFileSync(
			join(dir, "workspaces.json"),
			JSON.stringify([
				{
					id: "scratch",
					projectId: "p",
					name: "scratch",
					branch: "main",
					worktreePath: worktree,
					baseBranch: "main",
				},
			]),
		);
		const b = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
		const collector = await collectSocket(b.port, "scratch");
		collector.socket.send(
			JSON.stringify({
				id: "ready",
				method: "workspace.watchReady",
				params: { workspaceId: "scratch" },
			}),
		);
		expect((await collector.waitForFrame((frame) => frame.id === "ready")).ok).toBe(true);
		writeFileSync(join(scratch, "topic", "doc.md"), "v2\n");
		mkdirSync(join(scratch, "fresh"));
		writeFileSync(join(scratch, "fresh", "new.md"), "x\n");
		const published = (path: string) => (frame: SocketFrame) =>
			frame.channel === WS_CHANNELS.workspaceFsChanged &&
			(frame.data as WorkspaceFsChangedPayload).paths.includes(path);
		await collector.waitForFrame(published(".raildesign/context/topic/doc.md"));
		await collector.waitForFrame(published(".raildesign/context/fresh/new.md"));
	},
);

test.each([
	["exactly at the frame cap reaches its handler", WS_MAX_FRAME_BYTES, "answered"],
	["one byte over the frame cap closes the socket", WS_MAX_FRAME_BYTES + 1, "closed"],
])("a request frame %s", async (_name, bytes, expected) => {
	const b = await boot({ port: grabFreePort(), host: "localhost", portMode: "exact" });
	const collector = await collectSocket(b.port, "frame-cap");
	const closed = new Promise<string>((resolve) =>
		collector.socket.addEventListener("close", () => resolve("closed")),
	);
	const envelope = JSON.stringify({ id: "cap", method: "project.list", params: { padding: "" } });
	const padding = "A".repeat(bytes - envelope.length);
	collector.socket.send(JSON.stringify({ id: "cap", method: "project.list", params: { padding } }));

	const outcome = await Promise.race([
		collector
			.waitForFrame((candidate) => candidate.id === "cap")
			.then((frame) => (frame.ok ? "answered" : "failed")),
		closed,
	]);
	expect(outcome).toBe(expected);
	collector.socket.close();
});

test("shutdown is idempotent and releases the port", async () => {
	const options = { port: grabFreePort(), host: "localhost", portMode: "exact" as const };
	const first = await boot(options);
	await Promise.all([first.server.shutdown(), first.server.shutdown()]);
	booted.splice(booted.indexOf(first), 1);
	const second = await boot(options);
	expect(second.port).toBe(options.port);
});

test("publishes only changed host update notices after welcome and on fixed repeats", async () => {
	const checks = createCheckHarness<HostUpdateNotice | null>();
	const b = await boot({
		port: grabFreePort(),
		host: "localhost",
		portMode: "exact",
		hostUpdate: { intervalMs: 5, check: checks.check, run: async () => {} },
	});
	const firstCheck = await checks.waitForCheck(0);
	const collector = await collectSocket(b.port, "updates-first");
	const welcomeFrame = await collector.waitForFrame(
		(frame) => frame.channel === WS_CHANNELS.serverWelcome,
	);
	expect((welcomeFrame.data as ServerWelcome).hostUpdate).toBeUndefined();
	expect(checks.checks).toHaveLength(1);

	const firstNotice: HostUpdateNotice = {
		currentVersion: "1.0.0",
		availableVersion: "1.1.0",
		channel: "stable",
	};
	firstCheck.resolve(firstNotice);
	const availableFirstNotice: HostUpdateNotice = { ...firstNotice, status: "available" };
	const firstPush = await collector.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).availableVersion === "1.1.0",
	);
	expect(firstPush.data).toEqual(availableFirstNotice);

	const retained = await collectSocket(b.port, "updates-retained");
	const retainedWelcome = await retained.waitForFrame(
		(frame) => frame.channel === WS_CHANNELS.serverWelcome,
	);
	expect((retainedWelcome.data as ServerWelcome).hostUpdate).toEqual(availableFirstNotice);
	retained.socket.close();

	const secondCheck = await checks.waitForCheck(1);
	const newerNotice: HostUpdateNotice = {
		currentVersion: "1.0.0",
		availableVersion: "1.2.0",
		channel: "stable",
	};
	secondCheck.resolve(newerNotice);
	await collector.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).availableVersion === "1.2.0",
	);

	const duplicateCheck = await checks.waitForCheck(2);
	duplicateCheck.resolve({ ...newerNotice });
	const noUpdateCheck = await checks.waitForCheck(3);
	await socketBarrier(collector, "duplicate-barrier");
	expect(
		collector.frames.filter((frame) => frame.channel === WS_CHANNELS.hostUpdateAvailable),
	).toHaveLength(2);

	noUpdateCheck.resolve(null);
	const failedCheck = await checks.waitForCheck(4);
	await socketBarrier(collector, "no-update-barrier");
	expect(
		collector.frames.filter((frame) => frame.channel === WS_CHANNELS.hostUpdateAvailable),
	).toHaveLength(2);

	failedCheck.reject(new Error("offline"));
	await checks.waitForCheck(5);
	await socketBarrier(collector, "failure-barrier");
	expect(
		collector.frames.filter((frame) => frame.channel === WS_CHANNELS.hostUpdateAvailable),
	).toHaveLength(2);
	const afterSilentChecks = await collectSocket(b.port, "updates-after-silent-checks");
	const latestWelcome = await afterSilentChecks.waitForFrame(
		(frame) => frame.channel === WS_CHANNELS.serverWelcome,
	);
	expect((latestWelcome.data as ServerWelcome).hostUpdate).toEqual({
		...newerNotice,
		status: "available",
	});
	afterSilentChecks.socket.close();
	collector.socket.close();
});

test("host update runs are detached, single-flight, retryable, and success-latched", async () => {
	const checks = createCheckHarness<HostUpdateNotice | null>();
	const runs = createCheckHarness<void>();
	const b = await boot({
		port: grabFreePort(),
		host: "localhost",
		portMode: "exact",
		hostUpdate: { intervalMs: 50, check: checks.check, run: runs.check },
	});
	const firstCheck = await checks.waitForCheck(0);
	const firstClient = await collectSocket(b.port, "updates-run-first");
	const secondClient = await collectSocket(b.port, "updates-run-second");
	await Promise.all([
		firstClient.waitForFrame((frame) => frame.channel === WS_CHANNELS.serverWelcome),
		secondClient.waitForFrame((frame) => frame.channel === WS_CHANNELS.serverWelcome),
	]);

	firstCheck.resolve({
		currentVersion: "1.0.0",
		availableVersion: "1.1.0",
		channel: "stable",
	});
	await Promise.all(
		[firstClient, secondClient].map((client) =>
			client.waitForFrame(
				(frame) =>
					frame.channel === WS_CHANNELS.hostUpdateAvailable &&
					(frame.data as HostUpdateNotice).status === "available",
			),
		),
	);

	firstClient.socket.send(JSON.stringify({ id: "run-first", method: "host.update", params: {} }));
	const firstRun = await runs.waitForCheck(0);
	const [runAck] = await Promise.all([
		firstClient.waitForFrame((frame) => frame.id === "run-first"),
		...([firstClient, secondClient].map((client) =>
			client.waitForFrame(
				(frame) =>
					frame.channel === WS_CHANNELS.hostUpdateAvailable &&
					(frame.data as HostUpdateNotice).status === "running",
			),
		) as [Promise<SocketFrame>, Promise<SocketFrame>]),
	]);
	expect(runAck.ok).toBe(true);
	secondClient.socket.send(
		JSON.stringify({ id: "run-while-running", method: "host.update", params: {} }),
	);
	expect((await secondClient.waitForFrame((frame) => frame.id === "run-while-running")).ok).toBe(
		true,
	);
	expect(runs.checks).toHaveLength(1);

	firstRun.reject(new Error("private child diagnostic"));
	await Promise.all(
		[firstClient, secondClient].map((client) =>
			client.waitForFrame(
				(frame) =>
					frame.channel === WS_CHANNELS.hostUpdateAvailable &&
					(frame.data as HostUpdateNotice).status === "failed",
			),
		),
	);
	expect(JSON.stringify(firstClient.frames)).not.toContain("private child diagnostic");

	const sameReleaseCheck = await checks.waitForCheck(1);
	sameReleaseCheck.resolve({
		currentVersion: "1.0.0",
		availableVersion: "1.1.0",
		channel: "stable",
	});
	await sameReleaseCheck.promise;
	const afterSameRelease = await collectSocket(b.port, "updates-run-failed-snapshot");
	const failedWelcome = await afterSameRelease.waitForFrame(
		(frame) => frame.channel === WS_CHANNELS.serverWelcome,
	);
	expect((failedWelcome.data as ServerWelcome).hostUpdate?.status).toBe("failed");
	afterSameRelease.socket.close();

	const newerReleaseCheck = await checks.waitForCheck(2);
	newerReleaseCheck.resolve({
		currentVersion: "1.0.0",
		availableVersion: "1.2.0",
		channel: "stable",
	});
	await firstClient.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).availableVersion === "1.2.0" &&
			(frame.data as HostUpdateNotice).status === "available",
	);

	firstClient.socket.send(JSON.stringify({ id: "run-retry", method: "host.update", params: {} }));
	const retryRun = await runs.waitForCheck(1);
	await firstClient.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).availableVersion === "1.2.0" &&
			(frame.data as HostUpdateNotice).status === "running",
	);
	expect((await firstClient.waitForFrame((frame) => frame.id === "run-retry")).ok).toBe(true);
	retryRun.resolve(undefined);
	await Promise.all(
		[firstClient, secondClient].map((client) =>
			client.waitForFrame(
				(frame) =>
					frame.channel === WS_CHANNELS.hostUpdateAvailable &&
					(frame.data as HostUpdateNotice).availableVersion === "1.2.0" &&
					(frame.data as HostUpdateNotice).status === "succeeded",
			),
		),
	);

	const checksAfterSuccess = checks.checks.length;
	await Bun.sleep(120);
	expect(checks.checks).toHaveLength(checksAfterSuccess);
	firstClient.socket.send(
		JSON.stringify({ id: "run-after-success", method: "host.update", params: {} }),
	);
	expect((await firstClient.waitForFrame((frame) => frame.id === "run-after-success")).ok).toBe(
		true,
	);
	expect(runs.checks).toHaveLength(2);
	firstClient.socket.close();
	secondClient.socket.close();
});

test("shutdown makes a late host update run result inert", async () => {
	const checks = createCheckHarness<HostUpdateNotice | null>();
	const runs = createCheckHarness<void>();
	const b = await boot({
		port: grabFreePort(),
		host: "localhost",
		portMode: "exact",
		hostUpdate: { intervalMs: 1_000, check: checks.check, run: runs.check },
	});
	const collector = await collectSocket(b.port, "updates-run-shutdown");
	await collector.waitForFrame((frame) => frame.channel === WS_CHANNELS.serverWelcome);
	const firstCheck = await checks.waitForCheck(0);
	firstCheck.resolve({
		currentVersion: "1.0.0",
		availableVersion: "1.1.0",
		channel: "stable",
	});
	await collector.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).status === "available",
	);
	collector.socket.send(
		JSON.stringify({ id: "run-before-stop", method: "host.update", params: {} }),
	);
	const run = await runs.waitForCheck(0);
	await collector.waitForFrame(
		(frame) =>
			frame.channel === WS_CHANNELS.hostUpdateAvailable &&
			(frame.data as HostUpdateNotice).status === "running",
	);

	await b.server.shutdown();
	run.resolve(undefined);
	await run.promise;
	await Bun.sleep(10);

	expect(
		collector.frames.filter(
			(frame) =>
				frame.channel === WS_CHANNELS.hostUpdateAvailable &&
				(frame.data as HostUpdateNotice).status === "succeeded",
		),
	).toHaveLength(0);
});

test("shutdown clears periodic checks and makes a late result inert", async () => {
	const checks = createCheckHarness<HostUpdateNotice | null>();
	const b = await boot({
		port: grabFreePort(),
		host: "localhost",
		portMode: "exact",
		hostUpdate: { intervalMs: 5, check: checks.check, run: async () => {} },
	});
	const collector = await collectSocket(b.port, "updates-shutdown");
	await collector.waitForFrame((frame) => frame.channel === WS_CHANNELS.serverWelcome);
	const firstCheck = await checks.waitForCheck(0);

	await b.server.shutdown();
	firstCheck.resolve({
		currentVersion: "1.0.0",
		availableVersion: "1.1.0",
		channel: "stable",
	});
	await firstCheck.promise;
	await Bun.sleep(10);

	expect(checks.checks).toHaveLength(1);
	expect(
		collector.frames.filter((frame) => frame.channel === WS_CHANNELS.hostUpdateAvailable),
	).toHaveLength(0);
});

async function withFakeLoginShell(run: () => Promise<void>): Promise<void> {
	const saved = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), "thinkrail-boot-shell-"));
	tmpDirs.push(dir);
	const shell = join(dir, "login-shell");
	writeFileSync(
		shell,
		'#!/bin/sh\nfor last; do :; done\nBOOT_LOGIN_CANARY=imported exec /bin/sh -c "$last"\n',
	);
	chmodSync(shell, 0o755);
	process.env.SHELL = shell;
	delete process.env.TERM;
	delete process.env.BOOT_LOGIN_CANARY;
	try {
		await run();
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
		Object.assign(process.env, saved);
	}
}

test.skipIf(process.platform === "win32")(
	"boot leaves the process environment alone unless the launcher opts in to the login shell",
	async () => {
		await withFakeLoginShell(async () => {
			const first = await boot({ port: 0, host: "127.0.0.1", portMode: "exact" });
			expect(process.env.BOOT_LOGIN_CANARY).toBeUndefined();
			await first.server.shutdown();
			await boot({ port: 0, host: "127.0.0.1", portMode: "exact", resolveShellEnv: true });
			expect(process.env.BOOT_LOGIN_CANARY).toBe("imported");
		});
	},
);

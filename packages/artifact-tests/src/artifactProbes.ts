import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@thinkrail/contracts";
import { sessionDirFor, writeFixtureSession } from "@thinkrail/server/history-test-fixtures";
import { removeTree } from "@thinkrail/shared/removeTree";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { pollUntil, within } from "./lifecycle";

export interface ArtifactResources {
	readonly trashHelpers: { readonly macos: string; readonly windows: string };
}

export interface RunningArtifactHost {
	readonly origin: string;
	readonly resources: ArtifactResources;
	stop(): Promise<void>;
}

export interface ArtifactHostAdapter {
	readonly name: string;
	launch(env: Record<string, string>, label: string): Promise<RunningArtifactHost>;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function connectRpc(baseUrl: string): Promise<WebSocket> {
	const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws?protocol=${PROTOCOL_VERSION}`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
			once: true,
		});
	});
	return socket;
}

let requestSequence = 0;
function rpc(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
	const id = `artifact_${++requestSequence}`;
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("close", onClose);
		};
		const onClose = () => {
			cleanup();
			reject(new Error(`${method} connection closed`));
		};
		const onMessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			const frame = JSON.parse(event.data) as {
				id?: string;
				ok?: boolean;
				result?: unknown;
				error?: string;
			};
			if (frame.id !== id) return;
			cleanup();
			if (frame.ok) resolve(frame.result);
			else reject(new Error(frame.error ?? `${method} failed`));
		};
		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose, { once: true });
		socket.send(JSON.stringify({ id, method, params }));
	});
}

export function hostEnvironment(
	overrides: Record<string, string>,
	unset: string[] = [],
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const shadowed = new Set([...Object.keys(overrides), ...unset].map((name) => name.toLowerCase()));
	const inherited: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && !shadowed.has(name.toLowerCase())) inherited[name] = value;
	}
	return { ...inherited, ...overrides };
}

export async function runArtifactHostProbes(adapter: ArtifactHostAdapter): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), `raildesign-${adapter.name}-artifact-`));
	const home = join(root, "home");
	const data = join(root, "data");
	const projectDir = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "seed.txt"), "artifact seed\n");
	for (const args of [
		["init", "--quiet"],
		["add", "seed.txt"],
		[
			"-c",
			"user.name=RailDesign Smoke",
			"-c",
			"user.email=smoke@raildesign.invalid",
			"commit",
			"--quiet",
			"-m",
			"seed",
		],
	]) {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		assert(result.success, `fixture git failed: ${result.stderr.toString()}`);
	}
	const env = hostEnvironment(
		{
			...toolHomeEnv(home),
			LOCALAPPDATA: join(root, "local"),
			APPDATA: join(root, "roaming"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "xdg-data"),
			XDG_CACHE_HOME: join(root, "cache"),
			THINKRAIL_DATA_DIR: data,
			CI: "1",
		},
		["OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_API_KEY"],
	);
	let host: RunningArtifactHost | undefined;
	let socket: WebSocket | undefined;
	try {
		host = await adapter.launch(env, "workspace");
		const health = await within(fetch(`${host.origin}/health`), 10000, "GET /health");
		assert(health.ok && (await health.text()) === "ok", `/health answered ${health.status}`);
		const index = await within(fetch(host.origin), 10000, "GET /");
		assert(index.ok && (await index.text()).includes("RailDesign"), "RailDesign UI was not served");
		socket = await within(connectRpc(host.origin), 10000, "host WebSocket");
		const call = (method: string, params: unknown) => {
			assert(socket, "artifact WebSocket is not connected");
			return within(rpc(socket, method, params), 30000, method);
		};
		const providers = await call("provider.status", {});
		assert(
			providers &&
				typeof providers === "object" &&
				"providers" in providers &&
				Array.isArray(providers.providers),
			"provider.status did not return configured SDK endpoint status",
		);
		assert(!("jbcentral" in providers), "removed Central configuration reached the wire");
		assert(providers.providers.length === 0, "artifact inherited provider configuration");
		const project = (await call("project.open", { path: projectDir })) as { id: string };
		assert(project.id, "project.open returned no project id");
		const workspace = (await call("workspace.create", {
			projectId: project.id,
			name: "artifact-smoke",
		})) as { id: string; worktreePath: string };
		assert(
			workspace.id &&
				workspace.worktreePath &&
				resolve(workspace.worktreePath) !== resolve(projectDir),
			"workspace.create did not isolate the worktree",
		);
		const file = (await call("fs.readFile", { workspaceId: workspace.id, path: "seed.txt" })) as {
			content: string;
		};
		assert(file.content === "artifact seed\n", "workspace file content is wrong");
		const terminal = (await call("terminal.attach", {
			workspaceId: workspace.id,
			tabKey: "artifact-pty",
			cols: 80,
			rows: 24,
		})) as { id: string };
		assert(terminal.id, "terminal.attach returned no PTY id");
		await call("terminal.resize", { id: terminal.id, cols: 100, rows: 30 });
		await call("terminal.write", {
			id: terminal.id,
			data: "echo raildesign-pty-probe > artifact-pty.txt\r",
		});
		const outputPath = join(workspace.worktreePath, "artifact-pty.txt");
		await pollUntil(
			() =>
				existsSync(outputPath) &&
				readFileSync(outputPath, "utf8").trim() === "raildesign-pty-probe",
			{ timeoutMs: 10000, what: "PTY command in the selected worktree" },
		);
		const output = (await call("fs.readFile", {
			workspaceId: workspace.id,
			path: "artifact-pty.txt",
		})) as { content: string };
		assert(
			output.content.trim() === "raildesign-pty-probe",
			"PTY output file differs from the host file view",
		);
		assert(
			!existsSync(join(projectDir, "artifact-pty.txt")),
			"PTY command changed the original project directory",
		);
		const closed = (await call("terminal.close", {
			workspaceId: workspace.id,
			tabKey: "artifact-pty",
			force: true,
		})) as { closed: boolean };
		assert(closed.closed, "terminal.close did not close the PTY");
		const created = (await call("session.create", { workspaceId: workspace.id })) as {
			sessionId: string;
		};
		assert(created.sessionId, "session.create returned no session ID");
		const transcript = writeFixtureSession(sessionDirFor(data), {
			workspaceId: workspace.id,
			cwd: workspace.worktreePath,
			name: "artifact trash probe",
			messages: [{ role: "user", text: "move to trash", timestamp: Date.now() }],
		});
		await call("session.delete", { sessionId: transcript.id, workspaceId: workspace.id });
		assert(!existsSync(transcript.path), "session.delete left the transcript on disk");
		for (const helper of Object.values(host.resources.trashHelpers)) {
			assert(existsSync(helper), `native trash helper is missing: ${helper}`);
		}
		socket.close();
		socket = undefined;
		await host.stop();
		host = undefined;
		host = await adapter.launch(env, "restart");
		socket = await within(connectRpc(host.origin), 10000, "restart WebSocket");
		const restored = (await call("session.getMessages", {
			sessionId: created.sessionId,
			workspaceId: workspace.id,
		})) as { summary: { sessionId: string }; messages: unknown[] };
		assert(
			restored.summary.sessionId === created.sessionId && restored.messages.length === 0,
			"session record did not survive restart",
		);
		console.log(
			"host probe OK: workspace, files, PTY, transcript deletion and restart; SDK tool/advanced artifact acceptance remains a separate stage 4 gate.",
		);
	} finally {
		socket?.close();
		try {
			await host?.stop();
		} finally {
			removeTree(root);
		}
	}
}

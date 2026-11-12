import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMcpConnection,
	type McpConnection,
	mcpChildEnvironment,
	readMcpServerLog,
} from "./mcp";
import { saveCustomEndpoint } from "./modelConfiguration";

let root: string;
let previous: string | undefined;
const connections: McpConnection[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sdk-mcp-engine-"));
	previous = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	mkdirSync(process.env.THINKRAIL_DATA_DIR);
});
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => connection.close()));
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});
async function fixture(env: Record<string, string> = {}, signal?: AbortSignal) {
	const connection = await createMcpConnection({
		entry: {
			name: "fixture",
			source: "test",
			config: {
				command: process.execPath,
				args: [join(import.meta.dir, "mcp/fixtures/stdioServer.ts")],
				env,
				timeout: 2,
			},
		},
		cwd: root,
		...(signal ? { signal } : {}),
	});
	connections.push(connection);
	return connection;
}
test("public SDK stdio connects, enumerates and calls a real MCP fixture, then releases its subprocess", async () => {
	const pidFile = join(root, "pid");
	const connection = await fixture({ MCP_FIXTURE_PID_FILE: pidFile });
	expect((await connection.connect()).map((tool) => tool.name)).toContain("echo");
	expect(connection.status()).toMatchObject({ state: "connected", toolCount: 4 });
	expect(await connection.server.callTool("echo", { text: "hello" })).toEqual([
		{ type: "text", text: "echo: hello" },
	]);
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	await connection.close();
	expect(connection.status().state).toBe("disconnected");
	expect(() => process.kill(pid, 0)).toThrow();
	await expect(connection.connect()).rejects.toThrow("closed");
});
test("the official stdio adapter delegates pagination and preserves rich call result metadata", async () => {
	const connection = await fixture({ MCP_FIXTURE_PAGINATE: "1" });
	expect(await connection.connect()).toHaveLength(4);
	const result = await connection.server.callToolResult?.("rich", {});
	expect(result?.structuredContent).toEqual({ rows: [{ id: 1, title: "first" }] });
	expect(result?._meta).toEqual({ fixture: "metadata" });
	expect(result?.isError).toBe(false);
	expect(result?.content.map((item) => item.type)).toEqual(["text", "image", "resource_link"]);
	const content = await connection.server.callTool("rich", {});
	expect(content.structuredContent).toEqual({ rows: [{ id: 1, title: "first" }] });
	expect(Object.keys(content)).not.toContain("structuredContent");
});
test("stdio stderr storage stops at its per-connection byte budget", async () => {
	const connection = await createMcpConnection({
		entry: {
			name: "noisy",
			source: "test",
			config: {
				command: process.execPath,
				args: ["-e", "console.error('diagnostic line\\n'.repeat(20000)); process.exit(1)"],
			},
		},
		cwd: root,
	});
	connections.push(connection);
	await expect(connection.connect()).rejects.toThrow();
	const log = await readMcpServerLog("noisy");
	expect(log.text).toContain("stderr was truncated at 64 KiB");
	expect(statSync(log.path).size).toBeLessThan(128 * 1024);
});
test("early stdio stderr is captured in the real owned log and redacted without altering status errors", async () => {
	const connection = await createMcpConnection({
		entry: {
			name: "broken",
			source: "test",
			config: {
				command: process.execPath,
				args: ["-e", "console.error('fixture boom api_key=local-stderr-secret'); process.exit(1)"],
			},
		},
		cwd: root,
	});
	connections.push(connection);
	await expect(connection.connect()).rejects.toThrow();
	const log = await readMcpServerLog("broken");
	expect(log.text).toContain("fixture boom api_key=***");
	expect(log.text).not.toContain("local-stderr-secret");
	expect(connection.status().state).toBe("failed");
	expect(connection.status().detail).not.toContain("local-stderr-secret");
});
test("abort closes a starting SDK transport and a stubborn child is killed before close completes", async () => {
	const controller = new AbortController();
	const pidFile = join(root, "pid");
	const connection = await fixture(
		{
			MCP_FIXTURE_PID_FILE: pidFile,
			MCP_FIXTURE_INITIALIZE_DELAY_MS: "10000",
			MCP_FIXTURE_STUBBORN: "1",
		},
		controller.signal,
	);
	const pending = connection.connect();
	void pending.catch(() => {});
	for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await Bun.sleep(10);
	expect(existsSync(pidFile)).toBe(true);
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	controller.abort();
	await connection.close();
	await expect(pending).rejects.toBeDefined();
	expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);
test("MCP child environment reuses the shared model credential exclusion and explicit MCP references resolve", async () => {
	const original = {
		key: process.env.MCP_MODEL_CREDENTIAL,
		mcp: process.env.MCP_FIXTURE_TOKEN,
		other: process.env.OTHER_SECRET,
	};
	try {
		process.env.MCP_MODEL_CREDENTIAL = "model-secret";
		process.env.MCP_FIXTURE_TOKEN = "mcp-secret";
		process.env.OTHER_SECRET = "other-secret";
		await saveCustomEndpoint({
			name: "Model",
			baseUrl: "https://opencode.ai/inference/go/openai/v1",
			apiKey: `\${MCP_MODEL_CREDENTIAL}`,
			models: [
				{
					id: "deepseek-v4.1-flash",
					contextWindow: null,
					maxTokens: 512,
					reasoning: false,
					vision: false,
					tools: true,
				},
			],
		});
		const env = mcpChildEnvironment({ AUTH_FOR_MCP: `Bearer \${MCP_FIXTURE_TOKEN}` });
		expect(env.MCP_MODEL_CREDENTIAL).toBeUndefined();
		expect(env.MCP_FIXTURE_TOKEN).toBeUndefined();
		expect(env.OTHER_SECRET).toBeUndefined();
		expect(env.AUTH_FOR_MCP).toBe("Bearer mcp-secret");
	} finally {
		for (const [key, value] of Object.entries({
			MCP_MODEL_CREDENTIAL: original.key,
			MCP_FIXTURE_TOKEN: original.mcp,
			OTHER_SECRET: original.other,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test.skipIf(process.platform === "win32")(
	"MCP close terminates an owned descendant before it releases the transport",
	async () => {
		const pidFile = join(root, "descendant-pid");
		const connection = await fixture({ MCP_FIXTURE_DESCENDANT_PID_FILE: pidFile });
		await connection.connect();
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		await connection.close();
		expect(() => process.kill(pid, 0)).toThrow();
	},
);

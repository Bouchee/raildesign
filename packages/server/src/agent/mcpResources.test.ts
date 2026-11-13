import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, RunContext } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { Project } from "@thinkrail/contracts";
import { saveWorkspaces } from "../persistence";
import { fingerprintMcpEntry, MCP_SUMMARY_BYTES } from "./mcp";
import {
	closeAllMcpConnections,
	closeSessionMcpConnections,
	reconcileMcpSessions,
	sessionMcpTools,
	setMcpProjectResolver,
} from "./mcpSessions";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	promptSession,
	removeSession,
	setSessionResourceCleanup,
} from "./sdkSessionManager";
import { readSessionRecord, writeSessionRecord } from "./sessionStore";

const previous = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
	OPENAI_MODEL: process.env.OPENAI_MODEL,
};
let root: string;
let cwd: string;
let sessionId: string;
let active: boolean;
let policy: Pick<Project, "resourceTrust" | "mcpApprovals"> | undefined;
let controller: AbortController;
const failed: string[] = [];

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sdk-mcp-resources-"));
	cwd = join(root, "workspace");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	mkdirSync(process.env.THINKRAIL_DATA_DIR);
	process.env.OPENAI_API_KEY = "offline-test-key";
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
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
	({ sessionId } = await createSession({ workspaceId: "workspace", cwd }));
	active = true;
	policy = undefined;
	controller = new AbortController();
	failed.length = 0;
	setMcpProjectResolver(() => policy);
	setSessionResourceCleanup(closeSessionMcpConnections);
});
afterEach(async () => {
	await closeAllMcpConnections();
	disposeAllSessions();
	configureAgentModelFactory();
	setMcpProjectResolver(undefined);
	setSessionResourceCleanup(undefined);
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
function configuration(exposure = "direct", env: Record<string, string> = {}) {
	return {
		command: process.execPath,
		args: [join(import.meta.dir, "mcp/fixtures/stdioServer.ts")],
		exposure,
		env: { MCP_FIXTURE_RESOURCES: "1", MCP_FIXTURE_NO_TOOLS: "1", ...env },
	};
}
function configure(exposure = "direct", env: Record<string, string> = {}) {
	const config = configuration(exposure, env);
	writeFileSync(join(root, "data/mcp.json"), JSON.stringify({ mcpServers: { docs: config } }));
	return config;
}
async function tools(owner = sessionId) {
	return sessionMcpTools({
		sessionId: owner,
		workspaceId: "workspace",
		cwd,
		signal: controller.signal,
		assertActive() {
			if (!active) throw new Error("Run revoked");
		},
		markToolFailed(id) {
			failed.push(id);
		},
	});
}
async function invoke(name: string, args: Record<string, unknown>, id: string) {
	const tool = (await tools()).find((candidate) => candidate.name === name);
	if (tool?.type !== "function") throw new Error(`Missing ${name}`);
	return tool.invoke(new RunContext(), JSON.stringify(args), {
		toolCall: functionCall(name, args, { callId: id }),
	});
}
function savedOutput(id: string) {
	return JSON.parse(
		readFileSync(
			join(
				root,
				"data/mcp-output",
				sessionId,
				`${createHash("sha256").update(id).digest("hex")}.txt`,
			),
			"utf8",
		),
	);
}
const done = () => modelResponse([assistantMessage("done")]);
const call = (name: string, args: Record<string, unknown>, callId: string) =>
	modelResponse([functionCall(name, args, { callId })]);

test("the real SDK session graph lists, templates and reads resources on one resource-only connection and restores cards", async () => {
	configure();
	const model = new ScriptedModel([
		call("list_mcp_resources", { server: null, cursor: null }, "list"),
		call("list_mcp_resource_templates", { server: null, cursor: null }, "templates"),
		call("read_mcp_resource", { server: "docs", uri: "fixture://notes/a" }, "read"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	await promptSession(sessionId, "Read the MCP fixture resource");
	const record = readSessionRecord(sessionId);
	const results = record?.messages.filter((item) => item.role === "toolResult");
	expect(results?.map((item) => item.toolName)).toEqual([
		"list_mcp_resources",
		"list_mcp_resource_templates",
		"read_mcp_resource",
	]);
	for (const id of ["list", "templates", "read"])
		expect(record?.effects[id]?.status).toBe("completed");
	expect(savedOutput("list").resources).toEqual([
		{ server: "docs", uri: "fixture://notes/a", name: "Note A", mimeType: "text/plain" },
		{ server: "docs", uri: "fixture://notes/b", name: "Note B", mimeType: "text/plain" },
	]);
	expect(savedOutput("templates").resourceTemplates).toEqual([
		{ server: "docs", uriTemplate: "fixture://notes/{id}", name: "Note", mimeType: "text/plain" },
	]);
	expect(savedOutput("read")).toEqual({
		server: "docs",
		uri: "fixture://notes/a",
		contents: [
			{ uri: "fixture://notes/a", mimeType: "text/plain", text: "MCP resource fixture note" },
		],
	});
	expect(JSON.stringify(results)).not.toMatch(/private metadata|ui:\/\/|fixture.invalid/);
	expect(JSON.stringify(model.calls[3]?.request.input)).toContain("MCP resource fixture note");
	expect(JSON.stringify(model.calls[3]?.request.input)).not.toContain('"thinkrail"');
	expect(results?.[2]).toMatchObject({
		isError: false,
		details: {
			server: "docs",
			tool: "read_mcp_resource",
			fullOutput: true,
			thinkrail: {
				blocks: [{ kind: "resource", uri: "fixture://notes/a", mimeType: "text/plain", chars: 25 }],
			},
		},
	});
	await removeSession(sessionId);
	expect(
		(await getSessionMessages(sessionId, "workspace", cwd)).messages.filter(
			(item) => item.role === "toolResult",
		),
	).toEqual(results ?? []);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	model.assertComplete();
});

test("server-specific listing keeps page cursors, aggregate listing walks all pages and app resources stay hidden", async () => {
	configure();
	const first = await invoke("list_mcp_resources", { server: "docs", cursor: null }, "first");
	expect(JSON.parse(first.content[0].text)).toEqual({
		server: "docs",
		resources: [
			{ server: "docs", uri: "fixture://notes/a", name: "Note A", mimeType: "text/plain" },
		],
		nextCursor: "second",
	});
	const second = await invoke("list_mcp_resources", { server: "docs", cursor: "second" }, "second");
	expect(JSON.parse(second.content[0].text).resources[0].uri).toBe("fixture://notes/b");
	const read = (await tools()).find((tool) => tool.name === "read_mcp_resource");
	if (read?.type !== "function") throw new Error("Missing resource tool");
	expect(
		await read.needsApproval(
			new RunContext(),
			{ server: "docs", uri: "fixture://notes/a" },
			"read-only",
		),
	).toBe(false);
});

test("deferred resource tools share search exposure and restore only successful search receipts", async () => {
	configure("deferred");
	const all = await tools();
	const resource = all.find((tool) => tool.name === "read_mcp_resource");
	const search = all.find((tool) => tool.name === "tool_search");
	if (resource?.type !== "function" || search?.type !== "function")
		throw new Error("Missing resource tools");
	const context = new RunContext();
	const agent = new Agent({ name: "resources" });
	expect(await resource.isEnabled(context, agent)).toBe(false);
	const found = await search.invoke(
		context,
		JSON.stringify({ query: "read_mcp_resource", limit: null }),
	);
	expect(found).toEqual([{ name: "read_mcp_resource", description: resource.description }]);
	expect(await resource.isEnabled(context, agent)).toBe(true);
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Missing session");
	record.effects.search = {
		runId: "run",
		name: "tool_search",
		arguments: {},
		status: "completed",
		result: JSON.stringify(found),
	};
	writeSessionRecord(record);
	await closeSessionMcpConnections(sessionId);
	const restored = (await tools()).find((tool) => tool.name === "read_mcp_resource");
	if (restored?.type !== "function") throw new Error("Missing restored resource");
	expect(await restored.isEnabled(context, agent)).toBe(true);
	configure("hidden");
	await reconcileMcpSessions([sessionId]);
	expect((await tools()).map((tool) => tool.name)).not.toContain("read_mcp_resource");
});

for (const change of ["hidden", "disabled", "target"])
	test(`captured resource tools reject ${change} configuration before remote reads`, async () => {
		const calls = join(root, "calls");
		configure("direct", { MCP_FIXTURE_RESOURCE_CALLS_FILE: calls });
		const resource = (await tools()).find((tool) => tool.name === "read_mcp_resource");
		if (resource?.type !== "function") throw new Error("Missing resource tool");
		const config = configuration(change === "hidden" ? "hidden" : "direct", {
			MCP_FIXTURE_RESOURCE_CALLS_FILE: calls,
		});
		writeFileSync(
			join(root, "data/mcp.json"),
			JSON.stringify({
				mcpServers: {
					docs: {
						...config,
						...(change === "disabled" ? { enabled: false } : {}),
						...(change === "target" ? { args: ["different"] } : {}),
					},
				},
			}),
		);
		const result = await resource.invoke(
			new RunContext(),
			JSON.stringify({ server: "docs", uri: "fixture://notes/a" }),
			{ toolCall: functionCall(resource.name, {}, { callId: "stale" }) },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("changed");
		expect(existsSync(calls)).toBe(false);
		expect(failed).toEqual(["stale"]);
	});

test("project resource trust removal invalidates a captured read without another remote request", async () => {
	const calls = join(root, "calls");
	const config = configuration("direct", { MCP_FIXTURE_RESOURCE_CALLS_FILE: calls });
	mkdirSync(join(cwd, ".raildesign"));
	writeFileSync(
		join(cwd, ".raildesign/mcp.json"),
		JSON.stringify({ mcpServers: { docs: config } }),
	);
	policy = {
		resourceTrust: "granted",
		mcpApprovals: { docs: fingerprintMcpEntry("docs", config) },
	};
	const resource = (await tools()).find((tool) => tool.name === "read_mcp_resource");
	if (resource?.type !== "function") throw new Error("Missing project resources");
	policy.resourceTrust = "untrusted";
	const result = await resource.invoke(
		new RunContext(),
		JSON.stringify({ server: "docs", uri: "fixture://notes/a" }),
		{ toolCall: functionCall(resource.name, {}, { callId: "revoked-trust" }) },
	);
	expect(result.isError).toBe(true);
	expect(existsSync(calls)).toBe(false);
});

test("invalid resource arguments and unknown/hidden servers fail with original call identities", async () => {
	configure();
	for (const [name, args] of [
		["list_mcp_resources", { server: null, cursor: "second" }],
		["read_mcp_resource", { server: "other", uri: "fixture://notes/a" }],
		["read_mcp_resource", { server: "docs", uri: "ui://fixture" }],
		["read_mcp_resource", { server: "docs", uri: null }],
	] as const) {
		const result = await invoke(name, args, name);
		expect(result.isError).toBe(true);
	}
	expect(failed).toEqual([
		"list_mcp_resources",
		"read_mcp_resource",
		"read_mcp_resource",
		"read_mcp_resource",
	]);
});

test("resource read previews and remote errors are UTF-8 bounded; binary bytes stay in complete output", async () => {
	configure();
	const big = await invoke(
		"read_mcp_resource",
		{ server: "docs", uri: "fixture://notes/big" },
		"big",
	);
	expect(Buffer.byteLength(big.content[0].text)).toBeLessThanOrEqual(MCP_SUMMARY_BYTES);
	expect(big.content[0].text).not.toContain("�");
	expect(big.details.truncated).toBe(true);
	expect(savedOutput("big").contents[0].text).toHaveLength("汉字🧪".repeat(20000).length);
	const binary = await invoke(
		"read_mcp_resource",
		{ server: "docs", uri: "fixture://blob" },
		"binary",
	);
	expect(binary.content[0].text).toContain("Binary application/octet-stream");
	expect(savedOutput("binary").contents[0].blob).toBe(
		Buffer.from("fixture binary").toString("base64"),
	);
	expect(JSON.stringify(binary.details)).not.toContain(
		Buffer.from("fixture binary").toString("base64"),
	);
	const error = await invoke(
		"read_mcp_resource",
		{ server: "docs", uri: "fixture://notes/error" },
		"error",
	);
	expect(error.isError).toBe(true);
	expect(Buffer.byteLength(error.content[0].text)).toBeLessThanOrEqual(MCP_SUMMARY_BYTES);
	expect(error.content[0].text).not.toMatch(/fixture-secret|�/);
	expect(failed).toEqual(["error"]);
});

test("aborting a resource read closes only its owning session connection and reconciliation cannot revive its grant", async () => {
	const calls = join(root, "calls");
	const pids = join(root, "pids");
	configure("direct", {
		MCP_FIXTURE_RESOURCE_CALLS_FILE: calls,
		MCP_FIXTURE_PID_FILE: pids,
		MCP_FIXTURE_RESOURCE_DELAY_MS: "10000",
	});
	const first = (await tools()).find((tool) => tool.name === "read_mcp_resource");
	if (first?.type !== "function") throw new Error("Missing resource tool");
	const other = await createSession({ workspaceId: "workspace", cwd });
	await tools(other.sessionId);
	const [firstPid, secondPid] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
	if (!firstPid || !secondPid) throw new Error("Missing fixture subprocesses");
	const pending = first.invoke(
		new RunContext(),
		JSON.stringify({ server: "docs", uri: "fixture://notes/a" }),
		{ toolCall: functionCall(first.name, {}, { callId: "aborted" }) },
	);
	void pending.catch(() => {});
	for (let i = 0; i < 100 && !existsSync(calls); i++) await Bun.sleep(10);
	expect(existsSync(calls)).toBe(true);
	controller.abort(new Error("Stopped"));
	await expect(pending).rejects.toBeDefined();
	expect(() => process.kill(firstPid, 0)).toThrow();
	expect(() => process.kill(secondPid, 0)).not.toThrow();
	expect(existsSync(join(root, "data/mcp-output", sessionId))).toBe(false);
	await reconcileMcpSessions([sessionId]);
	await expect(
		first.invoke(new RunContext(), JSON.stringify({ server: "docs", uri: "fixture://notes/a" })),
	).rejects.toBeDefined();
	controller = new AbortController();
	active = false;
	await expect(tools()).rejects.toThrow("Run revoked");
});

test("HTTP resource-only servers use one authenticated SDK connection and preserve cursors", async () => {
	let initializes = 0;
	const methods: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.headers.get("Authorization") !== "Bearer fixture-only-token")
				return new Response(null, { status: 401 });
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json();
			if (body.id === undefined) return new Response(null, { status: 202 });
			methods.push(body.method);
			let result: unknown = {};
			if (body.method === "initialize") {
				initializes++;
				result = {
					protocolVersion: body.params.protocolVersion,
					capabilities: { resources: {} },
					serverInfo: { name: "http-resources", version: "1.0.0" },
				};
			}
			if (body.method === "tools/list") result = { tools: [] };
			if (body.method === "resources/list")
				result =
					body.params?.cursor === "second"
						? { resources: [{ uri: "http-fixture://b", name: "B" }] }
						: { resources: [{ uri: "http-fixture://a", name: "A" }], nextCursor: "second" };
			if (body.method === "resources/templates/list")
				result = {
					resourceTemplates: [{ uriTemplate: "http-fixture://{name}", name: "HTTP template" }],
				};
			if (body.method === "resources/read")
				result = { contents: [{ uri: body.params.uri, text: "HTTP resource response" }] };
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	try {
		writeFileSync(
			join(root, "data/mcp.json"),
			JSON.stringify({
				mcpServers: {
					remote: {
						url: `http://127.0.0.1:${server.port}/mcp`,
						headers: { Authorization: "Bearer fixture-only-token" },
						exposure: "direct",
					},
				},
			}),
		);
		const model = new ScriptedModel([
			call("list_mcp_resources", { server: null, cursor: null }, "http-list"),
			call("list_mcp_resource_templates", { server: "remote", cursor: null }, "http-templates"),
			call("read_mcp_resource", { server: "remote", uri: "http-fixture://a" }, "http-read"),
			done(),
		]);
		configureAgentModelFactory(() => model);
		await promptSession(sessionId, "Read HTTP resources");
		expect(savedOutput("http-list").resources).toEqual([
			{ server: "remote", uri: "http-fixture://a", name: "A" },
			{ server: "remote", uri: "http-fixture://b", name: "B" },
		]);
		expect(savedOutput("http-read").contents[0].text).toBe("HTTP resource response");
		expect(initializes).toBe(1);
		expect(methods.filter((method) => method === "resources/read")).toHaveLength(1);
		expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
		model.assertComplete();
	} finally {
		await closeAllMcpConnections();
		server.stop(true);
	}
});

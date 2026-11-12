import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, RunContext, Runner } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { Project } from "@thinkrail/contracts";
import { saveWorkspaces } from "../persistence";
import {
	MCP_CONFIRM_ALWAYS,
	MCP_CONFIRM_CHAT,
	MCP_CONFIRM_CHOICES,
	MCP_CONFIRM_DENY,
	MCP_SUMMARY_BYTES,
} from "./mcp";
import {
	applySessionMcpApproval,
	closeAllMcpConnections,
	closeSessionMcpConnections,
	sessionMcpApproval,
	sessionMcpTools,
	setMcpProjectResolver,
	setMcpToolGrantWriter,
} from "./mcpSessions";
import { createSession, disposeAllSessions } from "./sdkSessionManager";
import { readSessionRecord, writeSessionRecord } from "./sessionStore";

let root: string;
let cwd: string;
let sessionId: string;
let previous: string | undefined;
let active: boolean;
let policy:
	| Pick<Project, "resourceTrust" | "mcpApprovals" | "mcpOverrides" | "mcpToolGrants">
	| undefined;
const failed: string[] = [];
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sdk-mcp-tools-"));
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
	active = true;
	failed.length = 0;
	setMcpProjectResolver(() => policy);
	setMcpToolGrantWriter((_workspaceId, server, target, name) => {
		policy ??= {};
		policy.mcpToolGrants ??= {};
		policy.mcpToolGrants[server] = { target, tools: [name] };
	});
});
afterEach(async () => {
	await closeAllMcpConnections();
	disposeAllSessions();
	setMcpProjectResolver(undefined);
	setMcpToolGrantWriter(undefined);
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});
function configure(exposure = "direct") {
	writeFileSync(
		join(root, "data/mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: {
					command: process.execPath,
					args: [join(import.meta.dir, "mcp/fixtures/stdioServer.ts")],
					env: { MCP_FIXTURE_NOTE_FILE: join(root, "note.txt") },
					exposure,
				},
			},
		}),
	);
}
async function tools() {
	return sessionMcpTools({
		sessionId,
		workspaceId: "workspace",
		cwd,
		signal: new AbortController().signal,
		assertActive() {
			if (!active) throw new Error("Run revoked");
		},
		markToolFailed: (id) => {
			failed.push(id);
		},
	});
}
function done() {
	return modelResponse([assistantMessage("done")]);
}

test("SDK MCP execution pauses before effects and preserves chat/project consent choices", async () => {
	configure();
	const all = await tools();
	const agent = new Agent({
		name: "MCP test",
		tools: all,
		model: new ScriptedModel([
			modelResponse([
				functionCall("mcp__docs__write_note", { text: "stored" }, { callId: "write" }),
			]),
			done(),
		]),
	});
	const runner = new Runner({ tracingDisabled: true });
	const paused = await runner.run(agent, "write a note");
	expect(paused.interruptions).toHaveLength(1);
	expect(existsSync(join(root, "note.txt"))).toBe(false);
	expect(sessionMcpApproval(sessionId, "mcp__docs__write_note")?.options).toEqual(
		MCP_CONFIRM_CHOICES,
	);
	expect(applySessionMcpApproval(sessionId, "mcp__docs__write_note", MCP_CONFIRM_CHAT)).toBe(true);
	const interruption = paused.interruptions[0];
	if (!interruption) throw new Error("Missing MCP approval");
	paused.state.approve(interruption);
	await runner.run(agent, paused.state);
	expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("stored");
	const write = all.find((item) => item.name === "mcp__docs__write_note");
	if (write?.type !== "function") throw new Error("Missing MCP function");
	expect(await write.needsApproval(new RunContext(), {}, "next")).toBe(false);
	expect(applySessionMcpApproval(sessionId, write.name, MCP_CONFIRM_ALWAYS)).toBe(true);
	expect(policy?.mcpToolGrants?.docs?.tools).toEqual([write.name]);
	expect(applySessionMcpApproval(sessionId, write.name, MCP_CONFIRM_DENY)).toBe(false);
});

test("deferred tools load through ordinary function search and retain bounded rich results", async () => {
	configure("deferred");
	const all = await tools();
	const context = new RunContext();
	const agent = new Agent({ name: "MCP discovery" });
	const rich = all.find((item) => item.name === "mcp__docs__rich");
	const search = all.find((item) => item.name === "tool_search");
	const big = all.find((item) => item.name === "mcp__docs__big");
	if (rich?.type !== "function" || search?.type !== "function" || big?.type !== "function")
		throw new Error("Missing MCP tools");
	expect(await rich.isEnabled(context, agent)).toBe(false);
	await search.invoke(context, JSON.stringify({ query: "rich", limit: null }));
	expect(await rich.isEnabled(context, agent)).toBe(true);
	expect(await rich.needsApproval(context, {}, "rich")).toBe(false);
	const result = await rich.invoke(context, "{}", {
		toolCall: functionCall("mcp__docs__rich", {}, { callId: "rich" }),
		signal: new AbortController().signal,
	});
	expect(result.details.thinkrail.structuredContent).toEqual({ rows: [{ id: 1, title: "first" }] });
	expect(result.details.thinkrail.blocks.map((block: { kind: string }) => block.kind)).toEqual([
		"text",
		"image",
		"resource_link",
	]);
	const large = await big.invoke(context, "{}", {
		toolCall: functionCall("mcp__docs__big", {}, { callId: "big" }),
	});
	expect(Buffer.byteLength(large.content[0].text)).toBeLessThanOrEqual(MCP_SUMMARY_BYTES);
	const outputs = Array.from(
		new Bun.Glob("*.txt").scanSync(join(root, "data/mcp-output", sessionId)),
	);
	expect(outputs).toHaveLength(2);
	expect(failed).toEqual([]);
});

test("captured MCP tools reject a changed target, disablement and revoked run before side effects", async () => {
	configure();
	const all = await tools();
	const write = all.find((item) => item.name === "mcp__docs__write_note");
	if (write?.type !== "function") throw new Error("Missing MCP function");
	const call = { toolCall: functionCall(write.name, {}, { callId: "stale" }) };
	configure("hidden");
	const result = await write.invoke(new RunContext(), JSON.stringify({ text: "forbidden" }), call);
	expect(result.isError).toBe(true);
	expect(existsSync(join(root, "note.txt"))).toBe(false);
	expect(() => applySessionMcpApproval(sessionId, write.name, MCP_CONFIRM_ALWAYS)).toThrow(
		"changed",
	);
	active = false;
	const revoked = await write.invoke(new RunContext(), JSON.stringify({ text: "forbidden" }), call);
	expect(revoked.isError).toBe(true);
	expect(failed).toEqual(["stale", "stale"]);
});

test("HTTP MCP execution uses the existing SDK connection and rejects another workspace", async () => {
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json();
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (body.method === "initialize")
				result = {
					protocolVersion: body.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				};
			if (body.method === "tools/list")
				result = {
					tools: [
						{
							name: "echo",
							description: "Echo from HTTP",
							annotations: { readOnlyHint: true },
							inputSchema: { type: "object", properties: { text: { type: "string" } } },
						},
					],
				};
			if (body.method === "tools/call") {
				calls++;
				result = { content: [{ type: "text", text: body.params.arguments.text }] };
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	try {
		writeFileSync(
			join(root, "data/mcp.json"),
			JSON.stringify({
				mcpServers: { remote: { url: `http://127.0.0.1:${server.port}/mcp`, exposure: "direct" } },
			}),
		);
		const all = await tools();
		const echo = all.find((item) => item.name === "mcp__remote__echo");
		if (echo?.type !== "function") throw new Error("Missing HTTP tool");
		const result = await echo.invoke(new RunContext(), JSON.stringify({ text: "http result" }), {
			toolCall: functionCall(echo.name, {}, { callId: "http" }),
		});
		expect(result.content[0].text).toBe("http result");
		expect(calls).toBe(1);
		expect(await echo.needsApproval(new RunContext(), {}, "http-next")).toBe(false);
		await expect(
			sessionMcpTools({
				sessionId,
				workspaceId: "other",
				cwd,
				signal: new AbortController().signal,
				assertActive() {},
				markToolFailed() {},
			}),
		).rejects.toThrow("different session");
	} finally {
		await closeAllMcpConnections();
		server.stop(true);
	}
});

test("completed search receipts restore only currently available deferred tools", async () => {
	configure("deferred");
	const all = await tools();
	const search = all.find((item) => item.name === "tool_search");
	if (search?.type !== "function") throw new Error("Missing tool search");
	const output = await search.invoke(
		new RunContext(),
		JSON.stringify({ query: "echo", limit: null }),
	);
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Missing session record");
	record.effects.search = {
		runId: "run",
		name: "tool_search",
		arguments: {},
		status: "completed",
		result: JSON.stringify(output),
	};
	writeSessionRecord(record);
	await closeSessionMcpConnections(sessionId);
	const restored = await tools();
	const echo = restored.find((item) => item.name === "mcp__docs__echo");
	if (echo?.type !== "function") throw new Error("Missing restored MCP tool");
	expect(await echo.isEnabled(new RunContext(), new Agent({ name: "restore" }))).toBe(true);
});

for (const layout of ["1", "line"]) {
	test(`MCP output truncation keeps complete UTF-8 characters for ${layout === "line" ? "one long line" : "multiple lines"}`, async () => {
		configure();
		const path = join(root, "data/mcp.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		config.mcpServers.docs.env.MCP_FIXTURE_UTF8 = layout;
		writeFileSync(path, JSON.stringify(config));
		const all = await tools();
		const big = all.find((entry) => entry.name === "mcp__docs__big");
		if (big?.type !== "function") throw new Error("Missing MCP fixture tool");
		const result = await big.invoke(new RunContext(), "{}", {
			toolCall: functionCall(big.name, {}, { callId: "utf8" }),
		});
		expect(result.content[0].text.length).toBeGreaterThan(0);
		expect(result.content[0].text).not.toContain("�");
		expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MCP_SUMMARY_BYTES);
		expect(result.details.truncated).toBe(true);
	});
}

test("captured MCP search marks revoked and malformed calls as failures", async () => {
	configure("deferred");
	const search = (await tools()).find((candidate) => candidate.name === "tool_search");
	if (search?.type !== "function") throw new Error("Missing search");
	configure("hidden");
	const stale = await search.invoke(
		new RunContext(),
		JSON.stringify({ query: "echo", limit: null }),
		{ toolCall: functionCall("tool_search", {}, { callId: "stale-search" }) },
	);
	expect(stale).toContain("changed");
	const invalid = await search.invoke(
		new RunContext(),
		JSON.stringify({ query: "", limit: null }),
		{ toolCall: functionCall("tool_search", {}, { callId: "invalid-search" }) },
	);
	expect(typeof invalid).toBe("string");
	expect(failed).toEqual(["stale-search", "invalid-search"]);
});

test("remote MCP errors are redacted and UTF-8 bounded before returning to model and UI", async () => {
	configure();
	const path = join(root, "data/mcp.json");
	const config = JSON.parse(readFileSync(path, "utf8"));
	config.mcpServers.docs.env.MCP_FIXTURE_ERROR = "1";
	writeFileSync(path, JSON.stringify(config));
	const echo = (await tools()).find((candidate) => candidate.name === "mcp__docs__echo");
	if (echo?.type !== "function") throw new Error("Missing echo");
	const result = await echo.invoke(new RunContext(), JSON.stringify({ text: "test" }), {
		toolCall: functionCall(echo.name, {}, { callId: "large-error" }),
	});
	expect(result.isError).toBe(true);
	const text = result.content[0].text;
	expect(text).toContain("token=***");
	expect(text).not.toContain("fixture-secret");
	expect(text).not.toContain("�");
	expect(Buffer.byteLength(text)).toBeGreaterThan(MCP_SUMMARY_BYTES - 12);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MCP_SUMMARY_BYTES);
	expect(failed).toEqual(["large-error"]);
});

import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.env.MCP_FIXTURE_PID_FILE;
if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);
if (process.env.MCP_FIXTURE_DESCENDANT_PID_FILE) {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: {},
	});
	writeFileSync(process.env.MCP_FIXTURE_DESCENDANT_PID_FILE, String(child.pid));
}
const initializeDelayMs = Number(process.env.MCP_FIXTURE_INITIALIZE_DELAY_MS ?? 0);
if (process.env.MCP_FIXTURE_STUBBORN === "1") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
}

const tools = [
	{
		name: "echo",
		description: "Echo the text back",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
		annotations: { readOnlyHint: true },
	},
	{
		name: "write_note",
		description: "Store a note",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	{
		name: "rich",
		description: "Return text, an image, a resource link and structured content",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: "big",
		description: "Return more text than a tool result keeps",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
];

const PIXEL =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function callResult(name: string, text: string): unknown {
	if (name === "write_note" && process.env.MCP_FIXTURE_NOTE_FILE)
		writeFileSync(process.env.MCP_FIXTURE_NOTE_FILE, text);
	if (name === "rich") {
		return {
			_meta: { fixture: "metadata" },
			isError: false,
			content: [
				{ type: "text", text: "rich result" },
				{ type: "image", data: PIXEL, mimeType: "image/png" },
				{
					type: "resource_link",
					uri: "file:///notes/a.md",
					name: "a.md",
					mimeType: "text/markdown",
				},
			],
			structuredContent: { rows: [{ id: 1, title: "first" }] },
		};
	}
	if (name === "big" && process.env.MCP_FIXTURE_UTF8 === "1") {
		return { content: [{ type: "text", text: "汉字\n".repeat(20000) }] };
	}
	if (name === "big" && process.env.MCP_FIXTURE_UTF8 === "line") {
		return { content: [{ type: "text", text: "汉字🧪".repeat(20000) }] };
	}
	if (name === "big") {
		return { content: [{ type: "text", text: "line of output\n".repeat(20_000) }] };
	}
	return { content: [{ type: "text", text: `${name}: ${text}` }] };
}

function reply(id: unknown, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize": {
			const result = {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1.0.0" },
			};
			setTimeout(() => reply(message.id, result), initializeDelayMs);
			return;
		}
		case "tools/list":
			if (process.env.MCP_FIXTURE_PAGINATE === "1")
				return reply(
					message.id,
					message.params?.cursor === "second"
						? { tools: tools.slice(2) }
						: { tools: tools.slice(0, 2), nextCursor: "second" },
				);
			return reply(message.id, { tools });
		case "tools/call": {
			if (process.env.MCP_FIXTURE_ERROR === "1") {
				process.stdout.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `token=fixture-secret ${"汉字🧪 error ".repeat(20000)}` } })}\n`,
				);
				return;
			}
			const args = (message.params?.arguments ?? {}) as { text?: string };
			return reply(message.id, callResult(String(message.params?.name), args.text ?? ""));
		}
		default:
			return reply(message.id, {});
	}
});
lines.on("close", () => {
	if (process.env.MCP_FIXTURE_STUBBORN !== "1") process.exit(0);
});

import { StringDecoder } from "node:string_decoder";
import { Client, InMemoryResponseCacheStore } from "@modelcontextprotocol/client";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { invalidateServerToolsCache, type MCPServer } from "@openai/agents";
import { z } from "zod";
import { isRecord } from "./config";
import { appendMcpLog } from "./log";
import { OwnedStdioTransport } from "./transport";

const metaSchema = z.record(z.string(), z.json());
const STDERR_LIMIT = 64 * 1024;

/** Public SDK interface over the official client, whose public stdio transport exposes stderr. */
export class LoggedStdioMcpServer implements MCPServer {
	readonly name: string;
	cacheToolsList = false;
	readonly errorFunction = null;
	private readonly client: Client;
	private readonly transport: OwnedStdioTransport;
	private readonly cache = new InMemoryResponseCacheStore();
	private readonly signal: AbortSignal;
	private readonly timeout: number;
	private closing: Promise<void> | undefined;
	private stderrBytes = 0;
	private stderrPending = "";
	private readonly decoder = new StringDecoder("utf8");

	constructor(
		options: StdioServerParameters & { name: string; timeout: number; signal: AbortSignal },
	) {
		this.name = options.name;
		this.timeout = options.timeout;
		this.signal = options.signal;
		this.transport = new OwnedStdioTransport(options, (chunk) => this.readStderr(chunk));
		this.client = new Client(
			{ name: "RailDesign", version: "1.0.0" },
			{ listMaxPages: 64, responseCacheStore: this.cache },
		);
	}
	private readStderr(chunk: Uint8Array): void {
		if (this.stderrBytes >= STDERR_LIMIT) return;
		const bytes = Buffer.from(chunk);
		const remaining = STDERR_LIMIT - this.stderrBytes;
		const accepted = bytes.subarray(0, remaining);
		this.stderrBytes += accepted.byteLength;
		this.stderrPending += this.decoder.write(accepted);
		const lines = this.stderrPending.split(/\r?\n/);
		this.stderrPending = lines.pop() ?? "";
		if (lines.length) appendMcpLog(this.name, lines.join("\n"));
		if (this.stderrBytes >= STDERR_LIMIT) {
			this.flushStderr();
			appendMcpLog(this.name, "MCP stderr was truncated at 64 KiB.");
		}
	}

	private flushStderr(): void {
		const text = this.stderrPending + this.decoder.end();
		this.stderrPending = "";
		if (text) appendMcpLog(this.name, text);
	}
	async connect(): Promise<void> {
		this.signal.throwIfAborted();
		await this.client.connect(this.transport, { timeout: this.timeout, signal: this.signal });
		this.signal.throwIfAborted();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = (async () => {
			const results = await Promise.allSettled([this.client.close(), this.transport.close()]);
			this.flushStderr();
			const errors = results
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason);
			if (errors.length)
				throw new AggregateError(errors, "The MCP subprocess could not close cleanly.");
		})();
		return this.closing;
	}
	async listTools(): ReturnType<MCPServer["listTools"]> {
		const result = await this.client.listTools(undefined, {
			timeout: this.timeout,
			signal: this.signal,
		});
		return result.tools.map((tool) => {
			const additionalProperties = tool.inputSchema.additionalProperties;
			if (additionalProperties !== undefined && typeof additionalProperties !== "boolean")
				throw new Error(
					`MCP tool "${tool.name}" has additionalProperties unsupported by the SDK tool schema.`,
				);
			return {
				...tool,
				inputSchema: {
					...tool.inputSchema,
					properties: tool.inputSchema.properties ?? {},
					required: tool.inputSchema.required ?? [],
					additionalProperties: additionalProperties ?? true,
				},
			};
		});
	}
	async callToolResult(
		...[tool, args, meta, options]: Parameters<NonNullable<MCPServer["callToolResult"]>>
	): ReturnType<NonNullable<MCPServer["callToolResult"]>> {
		const signal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
		const result = await this.client.callTool(
			{ name: tool, arguments: args ?? {}, ...(meta ? { _meta: metaSchema.parse(meta) } : {}) },
			{ timeout: this.timeout, signal },
		);
		const structuredContent = result.structuredContent;
		if (structuredContent !== undefined && !isRecord(structuredContent))
			throw new Error("MCP structuredContent must be an object for the SDK tool interface.");
		return {
			content: result.content,
			...(structuredContent !== undefined ? { structuredContent } : {}),
			...(result.isError !== undefined ? { isError: result.isError } : {}),
			...(result._meta !== undefined ? { _meta: result._meta } : {}),
		};
	}
	async callTool(...args: Parameters<MCPServer["callTool"]>): ReturnType<MCPServer["callTool"]> {
		const result = await this.callToolResult(...args);
		// SDK metadata is attached to the array without changing its serialized content blocks.
		for (const [key, value] of Object.entries({
			structuredContent: result.structuredContent,
			isError: result.isError,
			_meta: result._meta,
		})) {
			if (value !== undefined)
				Object.defineProperty(result.content, key, {
					value,
					enumerable: false,
					configurable: true,
				});
		}
		return result.content;
	}
	async invalidateToolsCache(): Promise<void> {
		this.cache.evict("tools/list");
		await invalidateServerToolsCache(this.name);
	}
}

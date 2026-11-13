import { resolve } from "node:path";
import {
	type MCPServer,
	MCPServerStreamableHttp,
	type MCPServerWithResources,
} from "@openai/agents";
import type { McpServerStatus } from "@thinkrail/contracts";
import { modelKeyEnvironmentNames } from "../modelConfiguration";
import { toolEnvironment } from "../sdkTools";
import { appendMcpLog } from "./log";
import { McpSignInRequiredError, OwnedMcpOAuthProvider } from "./oauth";
import { redactMcpText } from "./redact";
import { LoggedStdioMcpServer } from "./stdio";
import type { McpServerEntry } from "./types";

let authorization: ((provider: string) => Promise<string>) | undefined;
export function setMcpAuthorizationResolver(resolveAuthorization: typeof authorization): void {
	authorization = resolveAuthorization;
}

function expand(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const result = process.env[name];
		if (result === undefined) throw new Error(`MCP environment variable ${name} is not set.`);
		return result;
	});
}

export function mcpChildEnvironment(explicit: Record<string, string> = {}): Record<string, string> {
	const inherited = toolEnvironment(
		new Set(modelKeyEnvironmentNames().map((name) => name.toUpperCase())),
	);
	return {
		...Object.fromEntries(
			Object.entries(inherited).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		),
		...Object.fromEntries(Object.entries(explicit).map(([name, value]) => [name, expand(value)])),
	};
}

export interface McpConnection {
	readonly server: MCPServerWithResources;
	readonly entry: McpServerEntry;
	status(): McpServerStatus;
	connect(): ReturnType<MCPServer["listTools"]>;
	close(): Promise<void>;
}

/** One owned transport. No agent, model call or extension runtime is created for management. */
export async function createMcpConnection(options: {
	entry: McpServerEntry;
	cwd: string;
	signal?: AbortSignal;
	oauthProvider?: OwnedMcpOAuthProvider;
	onStatus?: (status: McpServerStatus) => void;
}): Promise<McpConnection> {
	const { entry } = options;
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	signal.throwIfAborted();
	let status: McpServerStatus = {
		name: entry.name,
		state: entry.config.enabled === false ? "disabled" : "disconnected",
		updatedAt: Date.now(),
	};
	const report = (change: Omit<McpServerStatus, "name" | "updatedAt">) => {
		status = {
			...change,
			...(change.detail ? { detail: redactMcpText(change.detail) } : {}),
			name: entry.name,
			updatedAt: Date.now(),
		};
		options.onStatus?.(status);
	};
	const write = (message: string, ...args: unknown[]) =>
		appendMcpLog(
			entry.name,
			[message, ...args.map((arg) => (arg instanceof Error ? arg.message : String(arg)))].join(" "),
		);
	const logger = {
		namespace: `mcp:${entry.name}`,
		debug: write,
		warn: write,
		error: write,
		dontLogModelData: true,
		dontLogToolData: true,
	};
	const config = entry.config;
	const timeout = (config.timeout ?? 30) * 1000;
	let server: MCPServerWithResources;
	if ("command" in config) {
		server = new LoggedStdioMcpServer({
			name: entry.name,
			command: expand(config.command),
			args: config.args?.map(expand) ?? [],
			env: mcpChildEnvironment(config.env),
			cwd: config.cwd ? resolve(options.cwd, expand(config.cwd)) : options.cwd,
			timeout,
			signal,
		});
	} else {
		const headers = Object.fromEntries(
			Object.entries(config.headers ?? {}).map(([name, value]) => [name, expand(value)]),
		);
		if (config.auth) {
			if (!authorization)
				throw new Error(
					`MCP auth provider "${config.auth.provider}" is not configured in this host.`,
				);
			headers.Authorization = await authorization(config.auth.provider);
			signal.throwIfAborted();
		}
		const provider =
			options.oauthProvider ??
			new OwnedMcpOAuthProvider({
				name: entry.name,
				config,
				redirectUrl:
					config.oauth?.callbackUrl ??
					`http://127.0.0.1:${config.oauth?.callbackPort ?? 23891}/callback`,
				signal,
			});
		server = new MCPServerStreamableHttp({
			name: entry.name,
			url: config.url,
			requestInit: { headers, signal },
			authProvider: provider,
			fetch: provider.fetch,
			timeout,
			clientSessionTimeoutSeconds: timeout / 1000,
			logger,
			errorFunction: null,
		});
	}
	let closed = false;
	let closing: Promise<void> | undefined;
	let connecting: ReturnType<MCPServer["listTools"]> | undefined;
	const close = (): Promise<void> => {
		if (closing) return closing;
		closed = true;
		controller.abort(new Error("MCP connection closed."));
		closing = server.close().finally(() => {
			signal.removeEventListener("abort", onAbort);
			report({ state: config.enabled === false ? "disabled" : "disconnected" });
		});
		return closing;
	};
	const onAbort = () => {
		if (!closed) void close().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return {
		entry,
		server,
		status: () => ({ ...status }),
		close,
		connect() {
			if (closed || signal.aborted) return Promise.reject(new Error("MCP connection is closed."));
			if (config.enabled === false)
				return Promise.reject(new Error("This MCP server is disabled."));
			if (connecting) return connecting;
			report({ state: "starting" });
			connecting = (async () => {
				try {
					await server.connect();
					if (closed || signal.aborted) {
						await server.close();
						signal.throwIfAborted();
						throw new Error("MCP connection is closed.");
					}
					const tools = await server.listTools();
					signal.throwIfAborted();
					report({ state: "connected", toolCount: tools.length });
					return tools;
				} catch (error) {
					if (!closed) {
						const detail = error instanceof Error ? error.message : String(error);
						report({
							state:
								error instanceof McpSignInRequiredError ||
								/unauthorized|needs sign-in/i.test(detail)
									? "needs-sign-in"
									: "failed",
							detail,
						});
						write(detail);
					}
					await server.close().catch(() => {});
					throw error;
				}
			})();
			return connecting;
		},
	};
}

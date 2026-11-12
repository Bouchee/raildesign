import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	type FSWatcher,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { type FunctionTool, mcpToFunctionTool, type Tool, tool } from "@openai/agents";
import type {
	McpListResult,
	McpReadOutputResult,
	McpServerResourceSummary,
	McpServerStatus,
	McpStatusSnapshot,
	Project,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { z } from "zod";
import { dataDir } from "../persistence";
import {
	appendMcpLog,
	createMcpConnection,
	createMcpToolConsent,
	deriveMcpServerStatuses,
	fingerprintMcpEntry,
	isMcpResultTool,
	isRecord,
	loadHostMcpConfig,
	MCP_CONFIRM_CHAT,
	MCP_CONFIRM_CHOICES,
	MCP_SUMMARY_BYTES,
	type McpConnection,
	type McpConsentCall,
	type McpServerConfig,
	mcpNamespace,
	mcpPolicyOf,
	redactMcpText,
	summarizeMcpConfigErrors,
	summarizeMcpResult,
	summarizeMcpServers,
} from "./mcp";
import { cancelAllMcpProbes } from "./mcpSignIn";
import { getSessionMessages, getSessionWorkspaceId, liveSessionIdsOf } from "./sdkSessionManager";
import { readSessionRecord } from "./sessionStore";

type ProjectPolicy = Pick<
	Project,
	"resourceTrust" | "mcpApprovals" | "mcpOverrides" | "mcpToolGrants"
>;
interface Context {
	cwd: string;
	project: ProjectPolicy | undefined;
}
interface Tracked {
	workspaceId: string;
	cwd: string;
	generation: number;
	connections: Map<string, McpConnection>;
	failures: Map<string, McpServerStatus>;
	controller: AbortController;
	disabledInChat: Set<string>;
	loaded: Map<string, McpServerConfig>;
	snapshot: McpStatusSnapshot;
	inFlight?: Promise<void>;
	tools: Map<string, McpToolBinding>;
	consent: ReturnType<typeof createMcpToolConsent>;
	exposed: Set<string>;
}
interface McpToolBinding {
	name: string;
	server: string;
	originalName: string;
	description: string;
	fingerprint: string;
	assertCurrent: () => McpServerConfig;
	call: McpConsentCall;
}
let writeToolGrant:
	| ((workspaceId: string, server: string, target: string, tool: string) => void)
	| undefined;

export function setMcpToolGrantWriter(writer: typeof writeToolGrant): void {
	writeToolGrant = writer;
}

const contexts = new Map<string, Context>();
const tracked = new Map<string, Tracked>();
type ChatPolicy = Pick<Tracked, "disabledInChat" | "consent">;
const closing = new Map<string, ChatPolicy & { workspaceId: string; done: Promise<void> }>();
const generations = new Map<string, number>();
const rememberedChat = new Map<string, ChatPolicy>();
let projectOf: ((workspaceId: string) => ProjectPolicy | undefined) | undefined;
let publish: (snapshot: McpStatusSnapshot) => void = () => {};
export function setMcpProjectResolver(fn: typeof projectOf): void {
	projectOf = fn;
}
export function setMcpStatusPublisher(fn: typeof publish): void {
	publish = fn;
}
function files(workspaceId: string, cwd: string, disabledInChat?: ReadonlySet<string>) {
	const project = projectOf ? projectOf(workspaceId) : contexts.get(workspaceId)?.project;
	return {
		agentDir: dataDir(),
		cwd,
		projectTrusted: project?.resourceTrust === "granted",
		policy: mcpPolicyOf(project),
		...(disabledInChat ? { disabledInChat } : {}),
	};
}
function emit(sessionId: string, state: Tracked): void {
	if (tracked.get(sessionId) !== state) return;
	const options = files(state.workspaceId, state.cwd, state.disabledInChat);
	const reported = {
		servers: new Map(
			[
				...state.failures,
				...[...state.connections].map(([name, connection]): [string, McpServerStatus] => [
					name,
					connection.status(),
				]),
			].map(([name, status]) => {
				return [
					name,
					{
						state: status.state,
						...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
						detail: status.detail ?? "",
					},
				];
			}),
		),
		configErrors: [],
	};
	state.generation = (generations.get(sessionId) ?? 0) + 1;
	generations.set(sessionId, state.generation);
	state.snapshot = {
		workspaceId: state.workspaceId,
		sessionId,
		generation: state.generation,
		servers: deriveMcpServerStatuses({
			summaries: summarizeMcpServers(options),
			reported,
			disabledInChat: state.disabledInChat,
			previous: state.snapshot.servers,
			now: Date.now(),
		}).map((status) =>
			status.state === "unknown" ? { ...status, state: "disconnected" } : status,
		),
	};
	publish(structuredClone(state.snapshot));
}
function begin(
	sessionId: string,
	chat: ChatPolicy | undefined = rememberedChat.get(sessionId),
): Tracked | undefined {
	const existing = tracked.get(sessionId);
	if (existing) return existing;
	if (closing.has(sessionId)) return undefined;
	const workspaceId = getSessionWorkspaceId(sessionId);
	const record = readSessionRecord(sessionId);
	if (!workspaceId || !record || record.workspaceId !== workspaceId) return undefined;
	rememberedChat.delete(sessionId);
	const state: Tracked = {
		workspaceId,
		cwd: record.cwd,
		generation: 0,
		connections: new Map(),
		failures: new Map(),
		controller: new AbortController(),
		disabledInChat: chat?.disabledInChat ?? new Set(),
		tools: new Map(),
		exposed: new Set(),
		consent:
			chat?.consent ??
			createMcpToolConsent({
				policy: () => files(workspaceId, record.cwd).policy,
				grantTool(server, target, toolName) {
					if (!writeToolGrant) throw new Error("Persistent MCP tool grants are unavailable");
					writeToolGrant(workspaceId, server, target, toolName);
				},
			}),
		loaded: new Map(),
		snapshot: { workspaceId, sessionId, generation: 0, servers: [] },
	};
	tracked.set(sessionId, state);
	const loaded = loadHostMcpConfig(files(workspaceId, record.cwd, state.disabledInChat));
	state.loaded = new Map(loaded.servers.map((entry) => [entry.name, entry.config]));
	emit(sessionId, state);
	state.inFlight = Promise.all(
		loaded.servers.map(async (entry) => {
			try {
				const connection = await createMcpConnection({
					entry,
					cwd: state.cwd,
					signal: state.controller.signal,
					onStatus: () => emit(sessionId, state),
				});
				if (tracked.get(sessionId) !== state) {
					await connection.close();
					return;
				}
				state.connections.set(entry.name, connection);
				emit(sessionId, state);
				if (entry.config.enabled !== false) await connection.connect().catch(() => {});
			} catch (error) {
				state.failures.set(entry.name, {
					name: entry.name,
					state: "failed",
					detail: redactMcpText(error instanceof Error ? error.message : String(error)),
					updatedAt: Date.now(),
				});
			}
		}),
	)
		.then(() => {
			emit(sessionId, state);
		})
		.catch(() => {
			emit(sessionId, state);
		});
	return state;
}
export async function refreshMcpStatus(
	sessionId: string,
	waitMs: number,
): Promise<McpStatusSnapshot | null> {
	const state = begin(sessionId);
	if (!state) return null;
	if (waitMs > 0 && state.inFlight) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			state.inFlight,
			new Promise<void>((done) => {
				timer = setTimeout(done, waitMs);
			}),
		]);
		clearTimeout(timer);
	}
	return tracked.get(sessionId) === state ? structuredClone(state.snapshot) : null;
}
export async function listMcpServers(options: {
	workspaceId: string;
	cwd: string;
	project: ProjectPolicy | undefined;
	waitMs: number;
}): Promise<McpListResult> {
	contexts.set(options.workspaceId, { cwd: options.cwd, project: options.project });
	const config = files(options.workspaceId, options.cwd);
	const statuses = await Promise.all(
		liveSessionIdsOf(options.workspaceId).map((sessionId) =>
			refreshMcpStatus(sessionId, options.waitMs),
		),
	);
	const configErrors = summarizeMcpConfigErrors(config);
	return {
		servers: summarizeMcpServers(config),
		statuses: statuses.filter((snapshot): snapshot is McpStatusSnapshot => snapshot !== null),
		...(configErrors.length ? { configErrors } : {}),
	};
}
export async function reconnectMcpServer(sessionId: string, name: string): Promise<void> {
	const state = begin(sessionId);
	if (!state) throw new CodedError("MCP_CONFIG_INVALID", "This chat is not attached.");
	await state.inFlight;
	await state.connections.get(name)?.close();
	const entry = loadHostMcpConfig(
		files(state.workspaceId, state.cwd, state.disabledInChat),
	).servers.find((candidate) => candidate.name === name);
	if (!entry)
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			`No trusted MCP server named "${name}" is configured for this chat.`,
		);
	const connection = await createMcpConnection({
		entry,
		cwd: state.cwd,
		signal: state.controller.signal,
		onStatus: () => emit(sessionId, state),
	});
	if (tracked.get(sessionId) !== state) {
		await connection.close();
		return;
	}
	state.connections.set(name, connection);
	state.failures.delete(name);
	state.loaded.set(name, entry.config);
	if (entry.config.enabled !== false) await connection.connect();
	emit(sessionId, state);
}
async function settleCleanups(tasks: readonly Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(tasks);
	const errors = results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason);
	if (errors.length)
		throw new AggregateError(errors, "MCP connections could not all close cleanly.");
}
export function closeSessionMcpConnections(sessionId: string): Promise<void> {
	rememberedChat.delete(sessionId);
	const current = closing.get(sessionId);
	if (current) return current.done;
	const state = tracked.get(sessionId);
	if (!state) return Promise.resolve();
	tracked.delete(sessionId);
	state.controller.abort(new Error("MCP session closed."));
	const done = settleCleanups([
		...[...state.connections.values()].map((connection) => connection.close()),
		...(state.inFlight ? [state.inFlight] : []),
	]).finally(() => {
		if (closing.get(sessionId)?.done === done) closing.delete(sessionId);
	});
	closing.set(sessionId, {
		workspaceId: state.workspaceId,
		disabledInChat: state.disabledInChat,
		consent: state.consent,
		done,
	});
	return done;
}
export async function pauseSessionMcpConnections(sessionId: string): Promise<void> {
	const chat = tracked.get(sessionId) ?? closing.get(sessionId) ?? rememberedChat.get(sessionId);
	await closeSessionMcpConnections(sessionId);
	if (chat && getSessionWorkspaceId(sessionId))
		rememberedChat.set(sessionId, { disabledInChat: chat.disabledInChat, consent: chat.consent });
}
export async function closeWorkspaceMcpConnections(workspaceId: string): Promise<void> {
	const states = new Map<string, ChatPolicy & { workspaceId: string }>([...closing, ...tracked]);
	for (const [sessionId, state] of states)
		if (state.workspaceId !== workspaceId) states.delete(sessionId);
	await settleCleanups([...states.keys()].map(closeSessionMcpConnections));
	for (const [sessionId, state] of states) {
		if (getSessionWorkspaceId(sessionId) === workspaceId)
			rememberedChat.set(sessionId, {
				disabledInChat: state.disabledInChat,
				consent: state.consent,
			});
	}
}
export async function reconcileMcpSessions(
	sessionIds: readonly string[],
): Promise<Record<string, "reloaded">> {
	const result: Record<string, "reloaded"> = {};
	for (const sessionId of sessionIds) {
		const chat = tracked.get(sessionId) ?? rememberedChat.get(sessionId);
		await closeSessionMcpConnections(sessionId);
		const state = begin(sessionId, chat);
		if (state) {
			result[sessionId] = "reloaded";
		}
	}
	return result;
}
export async function setSessionMcpServerEnabled(
	sessionId: string,
	name: string,
	enabled: boolean,
): Promise<void> {
	const state = begin(sessionId);
	if (!state?.loaded.has(name))
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			`No MCP server named "${name}" is configured for this chat.`,
		);
	if (enabled) state.disabledInChat.delete(name);
	else state.disabledInChat.add(name);
	await reconnectMcpServer(sessionId, name);
}
export function mcpResourceSummaries(sessionId: string): McpServerResourceSummary[] {
	const state = tracked.get(sessionId);
	return (
		state?.snapshot.servers.map((status) => ({
			name: status.name,
			state: status.state,
			...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
			transport: "url" in (state.loaded.get(status.name) ?? {}) ? "http" : "stdio",
		})) ?? []
	);
}
export function forgetMcpStatus(sessionId: string): void {
	void closeSessionMcpConnections(sessionId).catch(() => {});
}
export async function closeAllMcpConnections(): Promise<void> {
	try {
		await settleCleanups(
			[...new Set([...tracked.keys(), ...closing.keys()])].map(closeSessionMcpConnections),
		);
	} finally {
		rememberedChat.clear();
		contexts.clear();
		generations.clear();
	}
}
export function watchUserMcpConfig(
	options: { onSettingsChanged?: (path: string) => void } = {},
): () => Promise<void> {
	const root = dataDir();
	mkdirSync(root, { recursive: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	let stopped = false;
	let active: Promise<void> | undefined;
	watcher = watch(root, (_event, filename) => {
		if (stopped) return;
		if (filename !== null && filename !== "mcp.json") return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const reload = async () => {
				if (stopped) return;
				options.onSettingsChanged?.(join(root, "mcp.json"));
				await cancelAllMcpProbes();
				if (stopped) return;
				await reconcileMcpSessions(liveSessionIdsOf());
			};
			active = active ? active.then(reload, reload) : reload();
			void active.catch((error: unknown) =>
				appendMcpLog("host", error instanceof Error ? error.message : String(error)),
			);
		}, 300);
	});
	return () => {
		stopped = true;
		clearTimeout(timer);
		watcher?.close();
		return active ?? Promise.resolve();
	};
}

const OUTPUT_LIMIT = 1024 * 1024;
function outputPath(sessionId: string, toolCallId: string): string {
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error("Invalid session identity.");
	return join(
		dataDir(),
		"mcp-output",
		sessionId,
		`${createHash("sha256").update(toolCallId).digest("hex")}.txt`,
	);
}
function assertOutputDirectories(sessionId: string, create: boolean): void {
	const root = join(dataDir(), "mcp-output");
	const directory = dirname(outputPath(sessionId, ""));
	for (const path of [root, directory]) {
		if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("MCP output must stay in its owned directory.");
	}
}
export function storeMcpToolOutput(sessionId: string, toolCallId: string, text: string): string {
	const path = outputPath(sessionId, toolCallId);
	assertOutputDirectories(sessionId, true);
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, text);
	} finally {
		closeSync(fd);
	}
	return path;
}
export async function readMcpToolOutput(
	workspaceId: string,
	sessionId: string,
	toolCallId: string,
	cwd: string,
): Promise<McpReadOutputResult> {
	const { messages } = await getSessionMessages(sessionId, workspaceId, cwd);
	const message = messages.find(
		(candidate) => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
	);
	if (message?.role !== "toolResult" || !isMcpResultTool(message.toolName))
		return { available: false, reason: "unavailable" };
	const path = outputPath(sessionId, toolCallId);
	try {
		assertOutputDirectories(sessionId, false);
		const root = realpathSync(join(dataDir(), "mcp-output"));
		if (!realpathSync(path).startsWith(`${root}${sep}`))
			return { available: false, reason: "unavailable" };
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) return { available: false, reason: "unavailable" };
			const buffer = Buffer.alloc(Math.min(stat.size, OUTPUT_LIMIT));
			const read = readSync(fd, buffer, 0, buffer.length, 0);
			return {
				available: true,
				text: buffer.subarray(0, read).toString("utf8"),
				truncated: stat.size > read,
			};
		} finally {
			closeSync(fd);
		}
	} catch {
		return { available: false, reason: "expired" };
	}
}

function mcpToolError(error: unknown): string {
	const text = redactMcpText(error instanceof Error ? error.message : String(error));
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
		Buffer.from(text, "utf8").subarray(0, MCP_SUMMARY_BYTES),
		{ stream: true },
	);
}

export interface SessionMcpToolOptions {
	sessionId: string;
	workspaceId: string;
	cwd: string;
	signal: AbortSignal;
	assertActive: () => void;
	markToolFailed: (toolCallId: string) => void;
}

export function sessionMcpApproval(
	sessionId: string,
	toolName: string,
): { title: string; options: string[]; fingerprint: string } | undefined {
	const binding = tracked.get(sessionId)?.tools.get(toolName);
	if (!binding) return undefined;
	binding.assertCurrent();
	return {
		title: `Allow ${binding.server}/${binding.originalName}? It may change data.`,
		options: [...MCP_CONFIRM_CHOICES],
		fingerprint: binding.fingerprint,
	};
}

export function applySessionMcpApproval(
	sessionId: string,
	toolName: string,
	value: string | null,
): boolean {
	const state = tracked.get(sessionId);
	const binding = state?.tools.get(toolName);
	if (!state || !binding) throw new Error("This MCP approval is no longer available");
	binding.assertCurrent();
	if (value !== null && !MCP_CONFIRM_CHOICES.includes(value))
		throw new Error("Invalid MCP approval choice");
	return state.consent.applyChoice(binding.call, value ?? "Deny");
}

export async function sessionMcpTools(options: SessionMcpToolOptions): Promise<Tool[]> {
	options.assertActive();
	options.signal.throwIfAborted();
	const state = begin(options.sessionId);
	if (!state || state.workspaceId !== options.workspaceId || state.cwd !== options.cwd)
		throw new Error("MCP tools belong to a different session or workspace");
	await state.inFlight;
	options.assertActive();
	options.signal.throwIfAborted();
	state.tools.clear();
	const tools: Tool[] = [];
	for (const [serverName, connection] of state.connections) {
		if (connection.entry.config.enabled === false || connection.status().state !== "connected")
			continue;
		const definitions = await connection.connect();
		const invokeResult = connection.server.callToolResult?.bind(connection.server);
		if (!invokeResult) throw new Error("The MCP connection cannot return complete tool results");
		for (const definition of definitions) {
			const config = connection.entry.config;
			const exposure = config.toolExposure?.[definition.name] ?? config.exposure ?? "deferred";
			if (exposure === "hidden") continue;
			const name = `${mcpNamespace(serverName)}__${definition.name}`;
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || state.tools.has(name))
				throw new Error(
					"MCP tool names must be unique valid function names of at most 64 characters",
				);
			const fingerprint = fingerprintMcpEntry(serverName, config);
			const assertCurrent = () => {
				options.assertActive();
				options.signal.throwIfAborted();
				const current = loadHostMcpConfig(
					files(state.workspaceId, state.cwd, state.disabledInChat),
				).servers.find((entry) => entry.name === serverName)?.config;
				if (
					tracked.get(options.sessionId) !== state ||
					state.connections.get(serverName) !== connection ||
					!current ||
					current.enabled === false ||
					fingerprintMcpEntry(serverName, current) !== fingerprint
				)
					throw new Error("MCP trust or configuration changed before this call");
				return current;
			};
			const call: McpConsentCall = {
				server: serverName,
				tool: name,
				config,
				readOnly:
					"annotations" in definition &&
					isRecord(definition.annotations) &&
					definition.annotations.readOnlyHint === true,
				signal: options.signal,
				currentConfig: assertCurrent,
			};
			state.tools.set(name, {
				name,
				server: serverName,
				originalName: definition.name,
				description: (definition.description ?? "").slice(0, 2000),
				fingerprint,
				assertCurrent,
				call,
			});
			const converted = mcpToFunctionTool(definition, connection.server, false, {
				toolNameOverride: name,
			});
			const functionTool: FunctionTool<unknown, typeof converted.parameters, unknown> = converted;
			functionTool.isEnabled = async () => {
				assertCurrent();
				return exposure === "direct" || state.exposed.has(name);
			};
			functionTool.needsApproval = async () => state.consent.needsApproval(call);
			functionTool.invoke = async (_context, input, details) => {
				const toolCallId = details?.toolCall?.callId;
				try {
					assertCurrent();
					if (!toolCallId) throw new Error("MCP calls require a tool call identity");
					const args = z.record(z.string(), z.unknown()).parse(JSON.parse(input));
					const signal = details?.signal
						? AbortSignal.any([options.signal, details.signal])
						: options.signal;
					const result = await invokeResult(definition.name, args, null, { signal });
					assertCurrent();
					signal.throwIfAborted();
					storeMcpToolOutput(options.sessionId, toolCallId, JSON.stringify(result));
					if (result.isError) options.markToolFailed(toolCallId);
					const text = result.content
						.flatMap((block) =>
							isRecord(block) && block.type === "text" && typeof block.text === "string"
								? [block.text]
								: [],
						)
						.join("\n");
					const bytes = Buffer.from(text, "utf8");
					const preview = {
						content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
							bytes.subarray(0, MCP_SUMMARY_BYTES),
							{ stream: true },
						),
						truncated: bytes.length > MCP_SUMMARY_BYTES,
					};
					return {
						content: [
							{
								type: "text",
								text: preview.content,
							},
						],
						details: {
							server: serverName,
							tool: definition.name,
							thinkrail: summarizeMcpResult(name, result, result.isError === true),
							fullOutput: true,
							truncated: preview.truncated,
						},
						isError: result.isError === true,
					};
				} catch (error) {
					if (toolCallId) options.markToolFailed(toolCallId);
					return {
						content: [
							{
								type: "text",
								text: mcpToolError(error),
							},
						],
						isError: true,
					};
				}
			};
			tools.push(functionTool);
		}
	}
	const saved = readSessionRecord(options.sessionId);
	for (const decision of Object.values(saved?.decisions ?? {})) {
		if (!decision.value || decision.selection !== MCP_CONFIRM_CHAT || !decision.policyFingerprint)
			continue;
		const effect = saved?.effects[decision.toolCallId];
		const binding = effect ? state.tools.get(effect.name) : undefined;
		if (!binding || binding.fingerprint !== decision.policyFingerprint) continue;
		binding.assertCurrent();
		state.consent.applyChoice(binding.call, MCP_CONFIRM_CHAT);
	}
	for (const effect of Object.values(saved?.effects ?? {})) {
		if (effect.name !== "tool_search" || effect.status !== "completed" || !effect.result) continue;
		let matches: unknown;
		try {
			matches = JSON.parse(effect.result);
		} catch {
			continue;
		}
		if (!Array.isArray(matches)) continue;
		for (const match of matches)
			if (isRecord(match) && typeof match.name === "string" && state.tools.has(match.name))
				state.exposed.add(match.name);
	}
	if (tools.length) {
		const search = tool({
			name: "tool_search",
			description:
				"Find approved MCP tools by keywords. Matching tools become available for the next model step.",
			parameters: z.object({
				query: z.string().min(1),
				limit: z.number().int().min(1).max(20).nullable(),
			}),
			errorFunction: null,
			execute({ query, limit }) {
				options.assertActive();
				options.signal.throwIfAborted();
				const words = query.toLowerCase().split(/\s+/).filter(Boolean);
				const matches = [...state.tools.values()]
					.filter((binding) => {
						binding.assertCurrent();
						const text = `${binding.name} ${binding.description}`.toLowerCase();
						return words.some((word) => text.includes(word));
					})
					.slice(0, limit ?? 8);
				for (const binding of matches) state.exposed.add(binding.name);
				return matches.map(({ name, description }) => ({ name, description }));
			},
		});
		const invokeSearch = search.invoke;
		search.invoke = async (context, input, details) => {
			try {
				return await invokeSearch(context, input, details);
			} catch (error) {
				const callId = details?.toolCall?.callId;
				if (callId) options.markToolFailed(callId);
				return mcpToolError(error);
			}
		};
		tools.unshift(search);
	}
	return tools;
}

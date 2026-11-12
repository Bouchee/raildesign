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
import type {
	McpListResult,
	McpReadOutputResult,
	McpServerResourceSummary,
	McpServerStatus,
	McpStatusSnapshot,
	Project,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { dataDir } from "../persistence";
import {
	appendMcpLog,
	createMcpConnection,
	deriveMcpServerStatuses,
	isMcpResultTool,
	loadHostMcpConfig,
	type McpConnection,
	type McpServerConfig,
	mcpPolicyOf,
	redactMcpText,
	summarizeMcpConfigErrors,
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
}
const contexts = new Map<string, Context>();
const tracked = new Map<string, Tracked>();
const closing = new Map<
	string,
	{ workspaceId: string; disabledInChat: Set<string>; done: Promise<void> }
>();
const generations = new Map<string, number>();
const rememberedDisabled = new Map<string, Set<string>>();
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
	disabledInChat: Set<string> = rememberedDisabled.get(sessionId) ?? new Set(),
): Tracked | undefined {
	const existing = tracked.get(sessionId);
	if (existing) return existing;
	if (closing.has(sessionId)) return undefined;
	const workspaceId = getSessionWorkspaceId(sessionId);
	const record = readSessionRecord(sessionId);
	if (!workspaceId || !record || record.workspaceId !== workspaceId) return undefined;
	rememberedDisabled.delete(sessionId);
	const state: Tracked = {
		workspaceId,
		cwd: record.cwd,
		generation: 0,
		connections: new Map(),
		failures: new Map(),
		controller: new AbortController(),
		disabledInChat,
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
	rememberedDisabled.delete(sessionId);
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
		done,
	});
	return done;
}
export async function closeWorkspaceMcpConnections(workspaceId: string): Promise<void> {
	const states = new Map<string, { workspaceId: string; disabledInChat: Set<string> }>([
		...closing,
		...tracked,
	]);
	for (const [sessionId, state] of states)
		if (state.workspaceId !== workspaceId) states.delete(sessionId);
	await settleCleanups([...states.keys()].map(closeSessionMcpConnections));
	for (const [sessionId, state] of states) {
		if (getSessionWorkspaceId(sessionId) === workspaceId)
			rememberedDisabled.set(sessionId, state.disabledInChat);
	}
}
export async function reconcileMcpSessions(
	sessionIds: readonly string[],
): Promise<Record<string, "reloaded">> {
	const result: Record<string, "reloaded"> = {};
	for (const sessionId of sessionIds) {
		const disabled = tracked.get(sessionId)?.disabledInChat ?? rememberedDisabled.get(sessionId);
		await closeSessionMcpConnections(sessionId);
		const state = begin(sessionId, disabled);
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
		rememberedDisabled.clear();
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

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Agent,
	type AgentInputItem,
	MaxTurnsExceededError,
	Runner,
	RunState,
	type RunStreamEvent,
	type Tool,
} from "@openai/agents";
import type {
	AgentSettlement,
	AssistantMessage,
	ExtUiRequest,
	ExtUiResponse,
	ImageContent,
	QueueLane,
	RemovedQueuedMessage,
	SessionCreatedPayload,
	SessionDeletedPayload,
	SessionEvent,
	SessionEventPayload,
	SessionQueueContent,
	SessionQueueState,
	SessionState,
	SessionStateRecord,
	SessionStats,
	SessionSummary,
	ThinkingLevel,
	ToolResultMessage,
	TranscriptMessage,
	WireModel,
} from "@thinkrail/contracts";
import { firstPromptOfTexts, normalizeSessionTitle } from "@thinkrail/contracts";
import { parseToolResultContent } from "@thinkrail/extension-api/server";
import { z } from "zod";
import {
	interactiveTools,
	registrySdkTools,
	type SdkExtensionSnapshot,
	snapshotSdkExtensions,
	workspaceFiles,
} from "../extensions";
import { logger } from "../log";
import { loadConfig, loadWorkspaces } from "../persistence";
import { trashFile } from "../trash";
import { configureLocalSdkTracing } from "./localTracing";
import {
	createConfiguredModel,
	listAvailableModels,
	modelContextBudget,
	modelOutputBudget,
	responsesClientSettings,
} from "./modelConfiguration";
import { workspaceTools } from "./sdkTools";
import {
	type ApprovalRequest,
	listSessionRecords,
	PersistentSession,
	readSessionRecord,
	type SessionRecord,
	type StoredInput,
	sessionRecordPath,
} from "./sessionStore";
import { webFetch, webSearch } from "./webAccess";

const log = logger("agent");
interface ActiveRun {
	state?: RunState<unknown, Agent>;
	suspended?: boolean;
	inputId?: string;
	enabledExtensions: SdkExtensionSnapshot[];
	ready?: Promise<void>;
	markReady?: () => void;
	id: string;
	controller: AbortController;
	granted: boolean;
	done: Promise<void>;
	assistantId?: string;
	toolCalls: Map<string, { name: string; arguments: Record<string, unknown>; failed: boolean }>;
	startedTools: Set<string>;
	structuredResults?: Map<
		string,
		{
			content: ToolResultMessage["content"];
			details?: unknown;
			isError: boolean;
			terminate?: boolean;
		}
	>;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheRead: number;
		cacheWrite: number;
	};
	toolResponse?: {
		request: NonNullable<SessionRecord["pendingToolResponse"]>;
		resolve: () => void;
		reject: (error: Error) => void;
	};
	approval?: {
		request: ApprovalRequest;
		resolve: (approved: boolean) => void;
		reject: (error: Error) => void;
	};
}
interface Entry {
	summaryController?: AbortController;
	summaryDone?: Promise<void>;
	stopping?: boolean;
	store: PersistentSession;
	active?: ActiveRun;
	flush?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Entry>();
const closingSessions = new Set<string>();
const deletingSessions = new Set<string>();
const closingWorkspaces = new Set<string>();
let publish: (payload: SessionEventPayload, workspaceId: string) => void = () => {};
let publishCreated: (payload: SessionCreatedPayload) => void = () => {};
let publishDeleted: (payload: SessionDeletedPayload) => void = () => {};
let publishState: (record: SessionStateRecord) => void = () => {};
let publishDialog: (request: ExtUiRequest) => void = () => {};
let projectOf: (workspaceId: string) => string | null = () => null;
let releaseSessionResources: ((sessionId: string) => Promise<void>) | undefined;

export function setSessionResourceCleanup(fn: typeof releaseSessionResources): void {
	releaseSessionResources = fn;
}

export function setSessionPublisher(fn: typeof publish): void {
	publish = fn;
}
export function setSessionCreatedPublisher(fn: typeof publishCreated): void {
	publishCreated = fn;
}
export function setSessionDeletedPublisher(fn: typeof publishDeleted): void {
	publishDeleted = fn;
}
export function setSessionStatePublisher(fn: typeof publishState): void {
	publishState = fn;
}
export function setSessionProjectResolver(fn: typeof projectOf): void {
	projectOf = fn;
}
export function setExtUiPublisher(fn: typeof publishDialog): void {
	publishDialog = fn;
}

function idleState(): SessionState {
	return {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
}
function stateRecord(entry: Entry): SessionStateRecord {
	const record = entry.store.record;
	const firstPrompt = firstPromptOfTexts(
		record.messages.flatMap((message) =>
			message.role === "user" ? [textOf(message.content)] : [],
		),
	);
	return {
		sessionId: record.sessionId,
		workspaceId: record.workspaceId,
		projectId: projectOf(record.workspaceId) ?? "",
		state: structuredClone(record.state),
		...(record.title ? { title: record.title } : {}),
		...(firstPrompt ? { firstPrompt } : {}),
	};
}
function notifyState(entry: Entry): void {
	publishState(stateRecord(entry));
}
function flush(entry: Entry): void {
	if (entry.flush) clearTimeout(entry.flush);
	delete entry.flush;
	entry.store.update(() => {});
}
function emit(entry: Entry, event: SessionEvent, immediate = true): void {
	entry.store.record.eventSeq += 1;
	if (immediate) flush(entry);
	else if (!entry.flush) {
		entry.flush = setTimeout(() => {
			delete entry.flush;
			try {
				flush(entry);
			} catch (error) {
				log.error("Could not persist streamed session", error);
				entry.active?.controller.abort();
			}
		}, 100);
		entry.flush.unref();
	}
	const record = entry.store.record;
	publish(
		{
			sessionId: record.sessionId,
			runId: record.state.runId,
			seq: record.eventSeq,
			event: structuredClone(event),
		},
		record.workspaceId,
	);
}
function mustGet(sessionId: string): Entry {
	const entry = sessions.get(sessionId);
	if (!entry) throw new Error(`Unknown session: ${sessionId}`);
	return entry;
}
function assertActive(entry: Entry, run: ActiveRun): void {
	const workspace = loadWorkspaces().find(
		(candidate) => candidate.id === entry.store.record.workspaceId,
	);
	if (
		!run.granted ||
		run.controller.signal.aborted ||
		entry.active !== run ||
		sessions.get(entry.store.record.sessionId) !== entry ||
		!workspace ||
		resolve(workspace.worktreePath) !== entry.store.record.cwd
	)
		throw new Error("The run no longer has permission to execute");
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}
function summaryOf(entry: Entry): SessionSummary {
	const record = entry.store.record;
	const state = stateRecord(entry);
	return {
		sessionId: record.sessionId,
		workspaceId: record.workspaceId,
		title: record.title ?? "",
		...(state.firstPrompt ? { firstPrompt: state.firstPrompt } : {}),
		model: record.model,
		thinkingLevel: record.thinkingLevel,
		isStreaming: !!entry.active,
		messageCount: record.messages.length,
		updatedAt: record.updatedAt,
		live: sessions.has(record.sessionId),
		state: state.state,
		eventSeq: record.eventSeq,
		queue: queueStateOf(record),
	};
}
function appendMessage(entry: Entry, message: TranscriptMessage): void {
	const index = entry.store.record.messages.findIndex((item) => item.id === message.id);
	if (index === -1) entry.store.record.messages.push(message);
	else entry.store.record.messages[index] = message;
}
function assistant(
	entry: Entry,
	id: string,
	content: AssistantMessage["content"],
	reason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	const previous = entry.store.record.messages.find((message) => message.id === id);
	return {
		id,
		role: "assistant",
		content,
		api: "openai-responses",
		provider: entry.store.record.model?.provider ?? "",
		model: entry.store.record.model?.id ?? "",
		usage:
			previous?.role === "assistant"
				? previous.usage
				: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
		stopReason: reason,
		timestamp: previous?.timestamp ?? Date.now(),
	};
}
function startAssistant(entry: Entry, run: ActiveRun): AssistantMessage {
	if (!run.assistantId) {
		run.assistantId = randomUUID();
		const message = assistant(entry, run.assistantId, []);
		appendMessage(entry, message);
		emit(entry, { type: "message_start", message });
		return message;
	}
	const found = entry.store.record.messages.find((message) => message.id === run.assistantId);
	if (found?.role !== "assistant") throw new Error("Missing streamed message");
	return found;
}
function addToolCall(
	entry: Entry,
	run: ActiveRun,
	call: { callId: string; name: string; arguments: string },
): void {
	if (run.toolCalls.has(call.callId)) return;
	let args: Record<string, unknown> = {};
	let failed = false;
	try {
		const parsed: unknown = JSON.parse(call.arguments);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			args = parsed as Record<string, unknown>;
	} catch {
		failed = true;
	}
	run.toolCalls.set(call.callId, { name: call.name, arguments: args, failed });
	const message = assistant(
		entry,
		`call:${call.callId}`,
		[{ type: "toolCall", id: call.callId, name: call.name, arguments: args }],
		"toolUse",
	);
	appendMessage(entry, message);
	emit(entry, { type: "message_end", message });
}
function recordToolResult(
	entry: Entry,
	callId: string,
	name: string,
	output: string,
	isError = false,
	completed = true,
): void {
	const structured = entry.active?.structuredResults?.get(callId);
	if (structured) isError ||= structured.isError;
	const previous = entry.store.record.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === callId,
	);
	if (
		previous?.role === "toolResult" &&
		textOf(previous.content) === output &&
		previous.isError === isError
	)
		return;
	const message: TranscriptMessage = {
		id: `result:${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: structured?.content ?? [{ type: "text", text: output }],
		...(structured?.details !== undefined ? { details: structured.details } : {}),
		isError,
		timestamp: previous?.timestamp ?? Date.now(),
	};
	const answer = Object.values(entry.store.record.toolResponses).find(
		(receipt) => receipt.toolCallId === callId,
	);
	if (answer && message.role === "toolResult")
		message.details = isSupersededAnswer(answer.response) ? { kind: "ack" } : answer.response;
	appendMessage(entry, message);
	const effect = entry.store.record.effects[callId];
	if (effect)
		entry.store.update((record) => {
			const current = record.effects[callId];
			if (current) {
				current.status = completed ? "completed" : "unknown";
				current.result = output;
				current.isError = isError;
			}
		});
	emit(entry, {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: name,
		result: {
			content: message.content,
			...(message.role === "toolResult" && message.details !== undefined
				? { details: message.details }
				: {}),
		},
		isError,
	});
	emit(entry, { type: "message_end", message });
}

function projectStream(entry: Entry, run: ActiveRun, event: RunStreamEvent): void {
	if (!run.granted || entry.active !== run) return;
	if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
		const previous = startAssistant(entry, run);
		const message = {
			...previous,
			content: [{ type: "text" as const, text: textOf(previous.content) + event.data.delta }],
		};
		appendMessage(entry, message);
		emit(
			entry,
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: event.data.delta,
					partial: message,
				},
			},
			false,
		);
	}
	if (event.type !== "run_item_stream_event") return;
	const item = event.item;
	if (item.type === "message_output_item") {
		const previous = startAssistant(entry, run);
		const message = assistant(
			entry,
			previous.id ?? randomUUID(),
			item.rawItem.content.flatMap((part) =>
				part.type === "output_text"
					? [{ type: "text" as const, text: part.text }]
					: part.type === "refusal"
						? [{ type: "text" as const, text: part.refusal }]
						: [],
			),
		);
		appendMessage(entry, message);
		emit(entry, { type: "message_end", message });
		delete run.assistantId;
	} else if (item.type === "tool_call_item" && item.rawItem.type === "function_call") {
		addToolCall(entry, run, item.rawItem);
	} else if (
		item.type === "tool_call_output_item" &&
		item.rawItem.type === "function_call_result"
	) {
		const call = run.toolCalls.get(item.rawItem.callId);
		const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
		recordToolResult(entry, item.rawItem.callId, call?.name ?? "tool", text, call?.failed);
	} else if (item.type === "reasoning_item") {
		const text = item.rawItem.content
			.flatMap((part) => (part.type === "input_text" ? [part.text] : []))
			.join("\n");
		if (text) {
			const message = assistant(entry, item.rawItem.id ?? randomUUID(), [
				{ type: "thinking", thinking: text },
			]);
			appendMessage(entry, message);
			emit(entry, { type: "message_end", message });
		}
	}
}

async function waitForApproval(
	entry: Entry,
	run: ActiveRun,
	state: RunState<unknown, Agent<unknown, "text">>,
	call: { callId: string; name: string; arguments: string },
): Promise<boolean> {
	assertActive(entry, run);
	addToolCall(entry, run, call);
	const saved = entry.store.record.pendingApproval?.request;
	const request: ApprovalRequest =
		saved?.runId === run.id && saved.toolCallId === call.callId
			? saved
			: {
					id: randomUUID(),
					sessionId: entry.store.record.sessionId,
					runId: run.id,
					revision: entry.store.record.revision + 1,
					kind: "confirm",
					title: `Allow ${call.name}?`,
					message: call.arguments,
					toolCallId: call.callId,
					toolInput: run.toolCalls.get(call.callId)?.arguments ?? {},
				};
	const approved = new Promise<boolean>((resolveApproval, reject) => {
		run.approval = { request, resolve: resolveApproval, reject };
	});
	entry.store.update((record) => {
		record.pendingApproval = { request, checkpoint: state.toString() };
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: state.toString(),
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		record.state.needsInput = { interactionId: request.id, kind: "dialog", request };
	});
	publishDialog(request);
	notifyState(entry);
	run.markReady?.();
	return approved;
}

function isSupersededAnswer(response: unknown): boolean {
	return (
		typeof response === "object" &&
		response !== null &&
		"kind" in response &&
		response.kind === "superseded"
	);
}
async function waitForToolResponse(
	entry: Entry,
	run: ActiveRun,
	state: RunState<unknown, Agent>,
	call: { callId: string; name: string; arguments: string },
): Promise<void> {
	assertActive(entry, run);
	addToolCall(entry, run, call);
	const args = z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments));
	const policy = interactiveTools(
		(name) => !run.enabledExtensions.some((extension) => extension.name === name),
	).get(call.name);
	if (!policy) throw new Error("The interactive tool is unavailable");
	policy.validateArgs?.(args);
	if (
		Object.values(entry.store.record.toolResponses).some(
			(answer) => answer.runId === run.id && answer.toolCallId === call.callId,
		)
	)
		return;
	const saved = entry.store.record.pendingToolResponse;
	const request: NonNullable<SessionRecord["pendingToolResponse"]> =
		saved?.runId === run.id && saved.toolCallId === call.callId
			? saved
			: {
					id: randomUUID(),
					sessionId: entry.store.record.sessionId,
					runId: run.id,
					revision: entry.store.record.revision + 1,
					toolCallId: call.callId,
					toolName: call.name,
					args: { ...args },
					checkpoint: state.toString(),
				};
	const answered = new Promise<void>((resolve, reject) => {
		run.toolResponse = { request, resolve, reject };
	});
	entry.store.update((record) => {
		record.pendingToolResponse = { ...request, checkpoint: state.toString() };
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: state.toString(),
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		record.state.needsInput = {
			interactionId: request.id,
			kind: "tool-response",
			toolCallId: call.callId,
			runId: run.id,
			revision: request.revision,
		};
	});
	notifyState(entry);
	run.markReady?.();
	await answered;
}
export function respondToTool(
	sessionId: string,
	toolCallId: string,
	response: unknown,
	ownership: { runId: string; interactionId: string; revision: number },
): void {
	const entry = mustGet(sessionId);
	let parsed = response;
	const previous = entry.store.record.toolResponses[ownership.interactionId];
	if (previous) {
		if (
			previous.runId !== ownership.runId ||
			previous.revision !== ownership.revision ||
			previous.toolCallId !== toolCallId ||
			!isDeepStrictEqual(previous.response, parsed)
		)
			throw new Error("Conflicting tool response");
		return;
	}
	const run = entry.active;
	const pending = run?.toolResponse;
	if (
		!run ||
		!pending ||
		pending.request.id !== ownership.interactionId ||
		run.id !== ownership.runId ||
		pending.request.toolCallId !== toolCallId ||
		pending.request.revision !== ownership.revision
	)
		throw new Error("Tool response is stale or belongs to a different run");
	assertActive(entry, run);
	const args = pending.request.args;
	const policy = interactiveTools(
		(name) => !run.enabledExtensions.some((extension) => extension.name === name),
	).get(pending.request.toolName);
	if (!policy) throw new Error("The interactive tool is unavailable");
	policy.validateArgs?.(args);
	if (policy.parseResponse) parsed = policy.parseResponse(args, response);
	const message: TranscriptMessage = {
		id: `answer:${ownership.interactionId}`,
		role: "custom",
		customType: "tool-response",
		content: [
			{ type: "text", text: policy.describeResponse?.(args, parsed) ?? JSON.stringify(parsed) },
		],
		details: { toolCallId, response: parsed },
		display: false,
		timestamp: Date.now(),
	};
	entry.store.update((record) => {
		record.toolResponses[ownership.interactionId] = {
			runId: run.id,
			toolCallId,
			revision: ownership.revision,
			response: parsed,
		};
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: run.state?.toString() ?? pending.request.checkpoint,
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		record.messages.push(message);
		delete record.pendingToolResponse;
		record.state.needsInput = null;
	});
	emit(entry, { type: "message_end", message });
	delete run.toolResponse;
	notifyState(entry);
	pending.resolve();
}

export function resolveExtUi(response: ExtUiResponse): void {
	const entry = mustGet(response.sessionId);
	const decision = entry.store.record.decisions[response.id];
	if (decision) {
		if (
			decision.runId !== response.runId ||
			decision.revision !== response.revision ||
			decision.value !== response.value ||
			decision.toolCallId !== response.toolCallId
		)
			throw new Error("Conflicting approval response");
		return;
	}
	const run = entry.active;
	const pending = run?.approval;
	if (
		!run ||
		!pending ||
		pending.request.id !== response.id ||
		run.id !== response.runId ||
		pending.request.revision !== response.revision ||
		pending.request.toolCallId !== response.toolCallId ||
		typeof response.value !== "boolean"
	)
		throw new Error("Approval is stale or belongs to a different run");
	assertActive(entry, run);
	entry.store.update((record) => {
		record.decisions[response.id] = {
			runId: run.id,
			revision: response.revision,
			toolCallId: pending.request.toolCallId,
			value: response.value === true,
		};
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: run.state?.toString() ?? record.pendingApproval?.checkpoint ?? "",
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		delete record.pendingApproval;
		record.state.needsInput = null;
	});
	delete run.approval;
	notifyState(entry);
	pending.resolve(response.value);
}
export function pendingExtUiDialog(sessionId: string): ApprovalRequest | null {
	return sessions.get(sessionId)?.store.record.pendingApproval?.request ?? null;
}
export function notifyExtUi(
	sessionId: string,
	message: string,
	level: "info" | "warning" | "error",
): void {
	publishDialog({ id: randomUUID(), sessionId, kind: "notify", message, level });
}

function startStream(
	runner: Runner,
	agent: Agent,
	input: AgentInputItem[] | RunState<unknown, Agent>,
	session: PersistentSession,
	signal: AbortSignal,
) {
	return runner.run(agent, input, { stream: true, session, signal, maxTurns: 20 });
}

function captureStructuredToolResults(tools: Tool[], run: ActiveRun): void {
	run.structuredResults ??= new Map();
	for (const candidate of tools) {
		if (candidate.type !== "function") continue;
		const invoke = candidate.invoke;
		candidate.invoke = async (context, input, details) => {
			const result = await invoke(context, input, details);
			const callId = details?.toolCall?.callId;
			if (
				callId &&
				result &&
				typeof result === "object" &&
				"content" in result &&
				Array.isArray(result.content)
			) {
				const parsed = parseToolResultContent(result);
				const isError = "isError" in result && result.isError === true;
				run.structuredResults?.set(callId, {
					content: [{ type: "text", text: parsed.text }, ...parsed.images],
					...("details" in result ? { details: result.details } : {}),
					isError,
					...("terminate" in result && result.terminate === true ? { terminate: true } : {}),
				});
				const call = run.toolCalls.get(callId);
				if (call && isError) call.failed = true;
				return parsed.text;
			}
			return result;
		};
	}
}

async function executeRun(
	entry: Entry,
	run: ActiveRun,
	input: AgentInputItem[],
	recovery?: string,
): Promise<void> {
	let terminal: AgentSettlement = { stopReason: "stop" };
	try {
		assertActive(entry, run);
		const selected = entry.store.record.model;
		const model = selected
			? (await listAvailableModels()).find(
					(candidate) => candidate.id === selected.id && candidate.provider === selected.provider,
				)
			: undefined;
		if (!model) throw new Error("Configure a Responses-compatible model before sending a message");
		assertActive(entry, run);
		const buildAgent = () => {
			const agent = new Agent({
				name: "RailDesign",
				instructions: `You are RailDesign, a coding assistant. Work only in the assigned worktree: ${entry.store.record.cwd}. Use read and search to inspect files. Use apply_patch for edits and bash to run project checks. Request approval for commands and edits. A denied operation is not permission to try another route. Report actual checks and remaining limits.`,
				model: createConfiguredModel(model, entry.store.record.sessionId),
				tools: [
					...workspaceTools(
						{
							workspaceId: entry.store.record.workspaceId,
							cwd: entry.store.record.cwd,
							signal: run.controller.signal,
							assertActive: () => assertActive(entry, run),
						},
						(callId) => {
							const call = run.toolCalls.get(callId);
							if (call) call.failed = true;
						},
					),
					...registrySdkTools(
						{
							cwd: entry.store.record.cwd,
							webAccess: {
								search: async (query, count, signal) => {
									assertActive(entry, run);
									const result = await webSearch(query, count, signal ?? run.controller.signal);
									assertActive(entry, run);
									return result;
								},
								fetch: async (url, signal) => {
									assertActive(entry, run);
									const result = await webFetch(url, signal ?? run.controller.signal);
									assertActive(entry, run);
									return result;
								},
							},
							workspaceFiles,
							assertActive: () => assertActive(entry, run),
							markToolFailed: (callId) => {
								const call = run.toolCalls.get(callId);
								if (call) call.failed = true;
							},
							toolResponse: (callId) => {
								const answer = Object.values(entry.store.record.toolResponses).find(
									(receipt) => receipt.runId === run.id && receipt.toolCallId === callId,
								);
								if (!answer) throw new Error("The tool has no saved response");
								return isSupersededAnswer(answer.response)
									? { kind: "deferred" }
									: { kind: "response", value: answer.response };
							},
						},
						run.enabledExtensions,
					),
				],
				// A tool result marked `terminate` ends the run without another model call.
				toolUseBehavior: (_context, results) =>
					results.some(
						(result) =>
							result.type === "function_output" &&
							run.structuredResults?.get(result.runItem.rawItem.callId)?.terminate,
					)
						? { isFinalOutput: true, isInterrupted: undefined, finalOutput: "" }
						: { isFinalOutput: false, isInterrupted: undefined },
				modelSettings: {
					...responsesClientSettings,
					maxTokens: modelOutputBudget(model),
					...(model.reasoning && entry.store.record.thinkingLevel !== "off"
						? { reasoning: { effort: entry.store.record.thinkingLevel } }
						: {}),
				},
			});
			agent.on("agent_tool_start", (_context, _tool, details) => {
				assertActive(entry, run);
				if (details.toolCall.type !== "function_call") return;
				const toolCall = details.toolCall;
				addToolCall(entry, run, toolCall);
				const previous = entry.store.record.effects[toolCall.callId];
				if (previous) throw new Error("A recorded tool effect cannot be replayed");
				entry.store.update((record) => {
					delete record.runCheckpoint;
					record.effects[toolCall.callId] = {
						runId: run.id,
						name: toolCall.name,
						arguments: run.toolCalls.get(toolCall.callId)?.arguments ?? {},
						status: "started",
					};
				});
				run.startedTools.add(toolCall.callId);
				const call = run.toolCalls.get(toolCall.callId);
				emit(entry, {
					type: "tool_execution_start",
					toolCallId: toolCall.callId,
					toolName: toolCall.name,
					args: call?.arguments ?? {},
				});
			});
			agent.on("agent_tool_end", (_context, _tool, result, details) => {
				if (!run.granted || details.toolCall.type !== "function_call") return;
				recordToolResult(
					entry,
					details.toolCall.callId,
					details.toolCall.name,
					result,
					run.toolCalls.get(details.toolCall.callId)?.failed,
				);
			});
			captureStructuredToolResults(agent.tools, run);
			return agent;
		};
		let agent = buildAgent();
		configureLocalSdkTracing();
		const runner = new Runner({
			tracingDisabled: !loadConfig().sdkTracingEnabled,
			traceIncludeSensitiveData: false,
			callModelInputFilter: ({ modelData }) => {
				assertActive(entry, run);
				if (entry.store.record.runCheckpoint && !entry.store.record.pendingApproval)
					entry.store.update((record) => {
						delete record.runCheckpoint;
					});
				return modelData;
			},
		});
		let next: AgentInputItem[] | RunState<unknown, Agent<unknown, "text">> = recovery
			? await RunState.fromString(agent, recovery)
			: input;
		if (recovery && next instanceof RunState) {
			run.state = next;
			const pendingIds = new Set(next.pendingInput.map((item) => item.id));
			if (
				entry.store.record.queue.some(
					(input) => input.state === "staged" && !pendingIds.has(input.id),
				)
			)
				entry.store.update((record) => {
					for (const input of record.queue)
						if (input.state === "staged" && !pendingIds.has(input.id)) input.state = "pending";
				});
			stageSteering(entry);
			for (const interruption of next.getInterruptions()) {
				if (interruption.rawItem.type !== "function_call")
					throw new Error("Unsupported approval type");
				if (
					interactiveTools(
						(name) => !run.enabledExtensions.some((extension) => extension.name === name),
					).has(interruption.rawItem.name)
				) {
					await waitForToolResponse(entry, run, next, interruption.rawItem);
					assertActive(entry, run);
					next.approve(interruption);
					continue;
				}
				const saved = entry.store.record.pendingApproval;
				const callId = interruption.rawItem.callId;
				if (!saved) {
					const decision = Object.values(entry.store.record.decisions).find(
						(d) => d.runId === run.id && d.toolCallId === callId,
					);
					if (!decision) throw new Error("No saved decision for checkpoint");
					if (decision.value) next.approve(interruption);
					else next.reject(interruption);
				} else {
					const approved = await waitForApproval(entry, run, next, interruption.rawItem);
					assertActive(entry, run);
					if (approved) next.approve(interruption);
					else next.reject(interruption);
				}
			}
		}
		run.markReady?.();
		while (true) {
			assertActive(entry, run);
			const stream = await startStream(runner, agent, next, entry.store, run.controller.signal);
			run.state = stream.state;
			stageSteering(entry);
			for await (const event of stream) {
				projectStream(entry, run, event);
				stageSteering(entry);
			}
			await stream.completed;
			const lastUsage = stream.state.usage.requestUsageEntries?.at(-1);
			entry.store.record.modelContextTokens =
				lastUsage?.totalTokens ??
				(stream.state.usage.requests === 1 ? stream.state.usage.totalTokens : 0);
			run.usage = {
				inputTokens: stream.state.usage.inputTokens,
				outputTokens: stream.state.usage.outputTokens,
				totalTokens: stream.state.usage.totalTokens,
				cacheRead: stream.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cached_tokens === "number" ? detail.cached_tokens : 0),
					0,
				),
				cacheWrite: stream.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cache_write_tokens === "number" ? detail.cache_write_tokens : 0),
					0,
				),
			};
			if (run.controller.signal.aborted || stream.cancelled) throw new Error("Run cancelled");
			if (stream.error) throw stream.error;
			if (stream.interruptions.length === 0) break;
			for (const interruption of stream.interruptions) {
				if (interruption.rawItem.type !== "function_call")
					throw new Error("Unsupported approval type");
				if (
					interactiveTools(
						(name) => !run.enabledExtensions.some((extension) => extension.name === name),
					).has(interruption.rawItem.name)
				) {
					await waitForToolResponse(entry, run, stream.state, interruption.rawItem);
					assertActive(entry, run);
					stream.state.approve(interruption);
					continue;
				}
				const approved = await waitForApproval(entry, run, stream.state, interruption.rawItem);
				assertActive(entry, run);
				if (approved) stream.state.approve(interruption);
				else {
					const call = run.toolCalls.get(interruption.rawItem.callId);
					if (call) call.failed = true;
					stream.state.reject(interruption);
				}
			}
			const checkpoint = stream.state.toString();
			entry.store.update((record) => {
				record.runCheckpoint = {
					runId: run.id,
					checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			});
			run.controller.abort();
			run.controller = new AbortController();
			agent = buildAgent();
			next = await RunState.fromString(agent, checkpoint);
			run.state = next;
		}
	} catch (error) {
		run.markReady?.();
		if (run.suspended) return;
		terminal = {
			stopReason:
				!run.granted || run.controller.signal.aborted
					? "aborted"
					: error instanceof MaxTurnsExceededError
						? "length"
						: "error",
			...(run.controller.signal.aborted || !run.granted
				? {}
				: { errorMessage: error instanceof Error ? error.message : String(error) }),
		};
		const partial = run.assistantId
			? entry.store.record.messages.find((message) => message.id === run.assistantId)
			: undefined;
		if (terminal.stopReason !== "aborted" || partial?.role === "assistant") {
			const message = assistant(
				entry,
				run.assistantId ?? randomUUID(),
				partial?.role === "assistant" ? partial.content : [],
				terminal.stopReason,
			);
			if (terminal.errorMessage) message.errorMessage = terminal.errorMessage;
			appendMessage(entry, message);
			emit(entry, { type: "message_end", message });
		}
	} finally {
		try {
			if (!run.suspended) {
				for (const [callId, call] of run.toolCalls) {
					if (
						entry.store.record.messages.some(
							(message) => message.role === "toolResult" && message.toolCallId === callId,
						)
					)
						continue;
					const output = run.startedTools.has(callId)
						? "Operation interrupted; its result is unknown. Inspect the worktree before retrying."
						: "Operation was not executed because its approval or run was cancelled.";
					recordToolResult(entry, callId, call.name, output, true, false);
					if (
						!entry.store.record.history.some(
							(item) => item.type === "function_call_result" && item.callId === callId,
						)
					)
						await entry.store.addItems([
							{
								type: "function_call_result",
								callId,
								name: call.name,
								status: "incomplete",
								output,
							},
						]);
				}
				const lastAssistant = entry.store.record.messages.findLast(
					(message) => message.role === "assistant",
				);
				if (lastAssistant?.role === "assistant" && run.usage) {
					lastAssistant.usage.input = run.usage.inputTokens;
					lastAssistant.usage.output = run.usage.outputTokens;
					lastAssistant.usage.totalTokens = run.usage.totalTokens;
					lastAssistant.usage.cacheRead = run.usage.cacheRead;
					lastAssistant.usage.cacheWrite = run.usage.cacheWrite;
					emit(entry, { type: "message_end", message: lastAssistant });
				}
				run.granted = false;
				if (run.approval) {
					publishDialog({
						id: run.approval.request.id,
						sessionId: entry.store.record.sessionId,
						kind: "dismiss",
					});
					delete run.approval;
				}
				entry.store.record.state.execution = "idle";
				entry.store.record.state.needsInput = null;
				entry.store.record.state.completion =
					terminal.stopReason === "aborted"
						? { completionId: run.id, outcome: "cancelled" }
						: terminal.stopReason === "error" || terminal.stopReason === "length"
							? { completionId: run.id, outcome: "failed", failure: terminal.stopReason }
							: { completionId: run.id, outcome: "succeeded" };
				entry.store.record.state.completionUnread = terminal.stopReason !== "aborted";
				delete entry.store.record.pendingApproval;
				delete entry.store.record.pendingToolResponse;
				delete run.toolResponse;
				delete entry.store.record.runCheckpoint;
				for (const queued of entry.store.record.queue) {
					queued.state = "pending";
					if (terminal.errorMessage) queued.error = terminal.errorMessage;
				}
				emit(entry, { type: "agent_end", messages: entry.store.record.messages, willRetry: false });
				emit(entry, { type: "agent_settled", terminal });
			}
		} finally {
			run.granted = false;
			run.controller.abort();
			delete entry.active;
			notifyState(entry);
		}
	}
	if (terminal.stopReason === "stop" && !entry.stopping) {
		try {
			await compactSession(entry.store.record.sessionId, { force: false });
		} catch (error) {
			log.warn("Automatic summary kept the prior history", error);
		}
		await drainQueue(entry);
	}
}

function userItem(input: Pick<StoredInput, "id" | "text" | "images">): AgentInputItem {
	return {
		type: "message",
		id: input.id,
		role: "user",
		content: input.images?.length
			? [
					{ type: "input_text", text: input.text },
					...input.images.map((image) => ({
						type: "input_image" as const,
						image: `data:${image.mimeType};base64,${image.data}`,
					})),
				]
			: input.text,
	};
}
function queuedContent(input: StoredInput) {
	return {
		id: input.id,
		text: input.text,
		state: input.state,
		...(input.images?.length ? { images: structuredClone(input.images) } : {}),
		...(input.error ? { error: input.error } : {}),
	};
}
function queueOf(record: SessionRecord): SessionQueueContent {
	const queue = record.queue;
	return {
		steering: queue.filter((input) => input.kind === "steering").map(queuedContent),
		followUp: queue.filter((input) => input.kind === "followUp").map(queuedContent),
	};
}
export function getQueuedMessageContent(sessionId: string): SessionQueueContent {
	return queueOf(mustGet(sessionId).store.record);
}

function queueStateOf(record: SessionRecord): SessionQueueState {
	const project = (input: StoredInput) => ({
		id: input.id,
		text: input.text,
		state: input.state,
		...(input.error ? { error: input.error } : {}),
	});
	return {
		steering: record.queue.filter((input) => input.kind === "steering").map(project),
		followUp: record.queue.filter((input) => input.kind === "followUp").map(project),
		...(record.queue.some((input) => input.images?.length) ? { hasImages: true as const } : {}),
	};
}
export function queuedMessages(sessionId: string): SessionQueueState {
	return queueStateOf(mustGet(sessionId).store.record);
}

function publishQueue(entry: Entry): void {
	entry.store.record.state.queuedCount = entry.store.record.queue.length;
	emit(entry, { type: "queue_update", ...queuedMessages(entry.store.record.sessionId) });
	notifyState(entry);
}
function observeStore(entry: Entry): void {
	entry.store.onUpdate = (previous) => {
		if (JSON.stringify(previous.queue) === JSON.stringify(entry.store.record.queue)) return;
		const admitted = previous.queue.filter(
			(input) =>
				!entry.store.record.queue.some((current) => current.id === input.id) &&
				entry.store.record.history.some((item) => item.id === input.id),
		);
		for (const input of admitted) {
			const message = entry.store.record.messages.find((item) => item.id === input.id);
			if (!message || previous.messages.some((item) => item.id === input.id)) continue;
			emit(entry, { type: "message_end", message });
		}
		publishQueue(entry);
	};
}
function stageSteering(entry: Entry): void {
	const run = entry.active;
	if (!run?.state || !run.granted || run.controller.signal.aborted || entry.stopping) return;
	const waiting = entry.store.record.queue.filter(
		(input) => input.kind === "steering" && input.state === "pending",
	);
	if (!waiting.length) return;
	const previous = run.state.pendingInput;
	try {
		run.state.addInput(waiting.map(userItem));
		entry.store.update((record) => {
			for (const input of record.queue)
				if (waiting.some((item) => item.id === input.id)) {
					input.state = "staged";
					delete input.error;
				}
			if (record.runCheckpoint)
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: run.state?.toString() ?? record.runCheckpoint.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			if (record.pendingToolResponse) {
				record.pendingToolResponse.checkpoint =
					run.state?.toString() ?? record.pendingToolResponse.checkpoint;
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: record.pendingToolResponse.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			}
			if (record.pendingApproval) {
				record.pendingApproval.checkpoint =
					run.state?.toString() ?? record.pendingApproval.checkpoint;
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: record.pendingApproval.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			}
		});
	} catch (error) {
		run.state.clearPendingInput();
		if (previous.length) run.state.addInput(previous);
		const message = error instanceof Error ? error.message : String(error);
		if (waiting.some((input) => input.error !== message))
			entry.store.update((record) => {
				for (const input of record.queue)
					if (waiting.some((item) => item.id === input.id)) input.error = message;
			});
	}
}
function enqueue(
	sessionId: string,
	kind: QueueLane,
	text: string,
	images?: readonly ImageContent[],
	messageId: string = randomUUID(),
): void {
	const entry = mustGet(sessionId);
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (typeof text !== "string" || (!text.trim() && !images?.length))
		throw new Error("Message is empty");
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) throw new Error("Invalid input ID");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	const existing = entry.store.record.queue.find((input) => input.id === messageId);
	if (existing) {
		if (
			existing.kind !== kind ||
			existing.text !== text ||
			JSON.stringify(existing.images ?? []) !== JSON.stringify(images ?? [])
		)
			throw new Error("Conflicting input ID");
		return;
	}
	const previous = entry.store.record.messages.find((item) => item.id === messageId);
	if (previous) {
		if (
			previous.role !== "user" ||
			JSON.stringify(previous.content) !==
				JSON.stringify(images?.length ? [{ type: "text", text }, ...images] : text)
		)
			throw new Error("Conflicting input ID");
		return;
	}
	const pendingToolResponse = kind === "steering" ? entry.active?.toolResponse : undefined;
	entry.store.update((record) => {
		if (pendingToolResponse && entry.active) {
			record.toolResponses[pendingToolResponse.request.id] = {
				runId: entry.active.id,
				toolCallId: pendingToolResponse.request.toolCallId,
				revision: pendingToolResponse.request.revision,
				response: { kind: "superseded", inputId: messageId },
			};
			delete record.pendingToolResponse;
			record.state.needsInput = null;
		}
		record.queue.push({
			id: messageId,
			text,
			...(images?.length ? { images: structuredClone([...images]) } : {}),
			kind,
			state: "pending",
		});
	});
	if (kind === "steering") stageSteering(entry);
	if (pendingToolResponse && entry.active) {
		delete entry.active.toolResponse;
		pendingToolResponse.resolve();
	}
	if (!entry.active && !entry.stopping)
		void drainQueue(entry).catch((error) => log.error("Could not start queued input", error));
}
export function steerSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): void {
	enqueue(sessionId, "steering", text, images, messageId);
}
export function followUpSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): void {
	enqueue(sessionId, "followUp", text, images, messageId);
}
export function clearSessionQueue(sessionId: string, requireTextOnly = false): SessionQueueContent {
	const entry = mustGet(sessionId);
	const content = getQueuedMessageContent(sessionId);
	if (requireTextOnly && entry.store.record.queue.some((input) => input.images?.length))
		throw new Error("The queue contains images");
	if (entry.store.record.queue.some((input) => input.state === "staged"))
		throw new Error("Staged input cannot be withdrawn before settlement");
	entry.store.update((record) => {
		record.queue = [];
	});
	return content;
}
export function removeQueuedMessage(sessionId: string, messageId: string): RemovedQueuedMessage {
	const entry = mustGet(sessionId);
	const input = entry.store.record.queue.find((item) => item.id === messageId);
	if (input?.state === "staged")
		throw new Error("Staged input cannot be withdrawn before settlement");
	if (input)
		entry.store.update((record) => {
			record.queue = record.queue.filter((item) => item.id !== messageId);
		});
	return { removed: input ? queuedContent(input) : null, queue: queuedMessages(sessionId) };
}
export function updateQueuedMessage(
	sessionId: string,
	messageId: string,
	text: string,
	images?: readonly ImageContent[],
): void {
	const entry = mustGet(sessionId);
	const input = entry.store.record.queue.find((item) => item.id === messageId);
	if (!input || input.state === "staged")
		throw new Error("Queued input is unavailable for editing");
	if (!text.trim() && !images?.length) throw new Error("Message is empty");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	entry.store.update((record) => {
		const current = record.queue.find((item) => item.id === messageId);
		if (current) {
			current.text = text;
			if (images?.length) current.images = structuredClone([...images]);
			else delete current.images;
			delete current.error;
		}
	});
}
async function drainQueue(entry: Entry, steeringOnly = false): Promise<void> {
	if (
		entry.active ||
		entry.stopping ||
		closingSessions.has(entry.store.record.sessionId) ||
		deletingSessions.has(entry.store.record.sessionId)
	)
		return;
	const next =
		entry.store.record.queue.find((input) => input.kind === "steering") ??
		(steeringOnly ? undefined : entry.store.record.queue[0]);
	if (!next) return;
	try {
		await promptSession(entry.store.record.sessionId, next.text, next.images, next.id);
	} catch (error) {
		entry.store.update((record) => {
			const current = record.queue.find((input) => input.id === next.id);
			if (current) {
				current.state = "pending";
				current.error = error instanceof Error ? error.message : String(error);
			}
		});
		throw error;
	}
}
export async function sendSteeringNow(sessionId: string): Promise<void> {
	const entry = mustGet(sessionId);
	if (entry.active) {
		stageSteering(entry);
		return;
	}
	await drainQueue(entry, true);
}
export async function compactSession(
	sessionId: string,
	options: {
		operationId?: string | undefined;
		instructions?: string | undefined;
		force?: boolean | undefined;
	} = {},
): Promise<void> {
	const entry = mustGet(sessionId);
	if (
		entry.active ||
		entry.store.record.pendingApproval ||
		entry.store.record.pendingToolResponse ||
		entry.store.record.runCheckpoint ||
		entry.stopping
	)
		throw new Error("Wait for the run to settle before summarizing");
	if (entry.summaryController) throw new Error("A summary is already running");
	const selected = entry.store.record.model;
	if (!selected) throw new Error("Configure a model before summarizing");
	const controller = new AbortController();
	entry.summaryController = controller;
	let finishSummary: () => void = () => {};
	entry.summaryDone = new Promise((resolve) => {
		finishSummary = resolve;
	});
	try {
		const operationId = options.operationId ?? randomUUID();
		const summaryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const result = await entry.store.compact({
			operationId,
			usage: summaryUsage,
			tokensBefore: entry.store.record.modelContextTokens ?? 0,
			force: options.force ?? true,
			instructions: options.instructions,
			tokenBudget: modelContextBudget(selected),
			signal: controller.signal,
			summarize: async (prefix, signal) => {
				const agent = new Agent({
					name: "RailDesign summary",
					model: createConfiguredModel(selected, sessionId),
					instructions:
						"Summarize the older conversation for continuation. Preserve user requirements, decisions, file paths, exact facts, tool outcomes and unfinished work. Do not invent facts. Return only the summary.",
					modelSettings: { ...responsesClientSettings, maxTokens: modelOutputBudget(selected) },
				});
				configureLocalSdkTracing();
				const runner = new Runner({
					tracingDisabled: !loadConfig().sdkTracingEnabled,
					traceIncludeSensitiveData: false,
				});
				const response = await runner.run(
					agent,
					[
						{
							role: "user",
							content: `${options.instructions ?? ""}\nConversation:\n${JSON.stringify(prefix)}`,
						},
					],
					{ signal, maxTurns: 1 },
				);
				summaryUsage.input = response.state.usage.inputTokens;
				summaryUsage.output = response.state.usage.outputTokens;
				summaryUsage.total = response.state.usage.totalTokens;
				summaryUsage.cacheRead = response.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cached_tokens === "number" ? detail.cached_tokens : 0),
					0,
				);
				summaryUsage.cacheWrite = response.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cache_write_tokens === "number" ? detail.cache_write_tokens : 0),
					0,
				);
				return response.finalOutput ?? "";
			},
		});
		if (result.status === "compacted") {
			const message = entry.store.record.messages.find(
				(item) => item.id === `summary:${operationId}`,
			);
			if (message) emit(entry, { type: "message_end", message });
		}
	} finally {
		finishSummary();
		if (entry.summaryController === controller) {
			delete entry.summaryController;
			delete entry.summaryDone;
		}
	}
}

export interface CreateSessionInput {
	cwd: string;
	workspaceId: string;
	model?: WireModel;
	thinkingLevel?: ThinkingLevel;
	modelOptional?: boolean;
}
export interface CreateSessionResult {
	sessionId: string;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
}
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
	const workspace = loadWorkspaces().find((candidate) => candidate.id === input.workspaceId);
	if (!workspace || resolve(workspace.worktreePath) !== resolve(input.cwd))
		throw new Error("Session must use its assigned worktree");
	if (closingWorkspaces.has(input.workspaceId)) throw new Error("Workspace is closing");
	const available = await listAvailableModels();
	if (closingWorkspaces.has(input.workspaceId)) throw new Error("Workspace is closing");
	const requested = input.model;
	const model = requested
		? available.find((item) => item.provider === requested.provider && item.id === requested.id)
		: available[0];
	if (requested && !model && !input.modelOptional) throw new Error("Unknown model");
	const sessionId = randomUUID();
	const entry: Entry = {
		store: new PersistentSession({
			version: 2,
			sessionId,
			workspaceId: input.workspaceId,
			cwd: resolve(input.cwd),
			model: model ?? null,
			thinkingLevel: model?.thinkingLevels.includes(input.thinkingLevel ?? "off")
				? (input.thinkingLevel ?? "off")
				: "off",
			eventSeq: 0,
			revision: 0,
			history: [],
			messages: [],
			state: idleState(),
			updatedAt: Date.now(),
			decisions: {},
			toolResponses: {},
			queue: [],
			effects: {},
			historyOperations: {},
			summaryOperations: {},
			retiredInputIds: [],
			inputItems: {},
		}),
	};
	flush(entry);
	sessions.set(sessionId, entry);
	observeStore(entry);
	publishCreated(summaryOf(entry));
	notifyState(entry);
	return {
		sessionId,
		model: entry.store.record.model,
		thinkingLevel: entry.store.record.thinkingLevel,
	};
}
export function promptSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): Promise<void> {
	const entry = mustGet(sessionId);
	if (typeof text !== "string") throw new Error("Message must be text");
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (messageId) {
		const previous = entry.store.record.messages.find((item) => item.id === messageId);
		if (previous) {
			if (
				previous.role !== "user" ||
				JSON.stringify(previous.content) !==
					JSON.stringify(images?.length ? [{ type: "text", text }, ...images] : text)
			)
				throw new Error("Conflicting input ID");
			if (entry.active?.inputId === messageId) return entry.active.done;
			if (!entry.store.record.queue.some((item) => item.id === messageId)) return Promise.resolve();
		}
	}
	if (entry.active) throw new Error("A run is already active in this session");
	entry.summaryController?.abort();
	if (entry.stopping) throw new Error("Session is stopping");
	if (!text.trim() && !images?.length) throw new Error("Message is empty");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	const id = messageId ?? randomUUID();
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid input ID");
	const run: ActiveRun = {
		id: randomUUID(),
		inputId: id,
		enabledExtensions: snapshotSdkExtensions(
			loadConfig().disabledExtensions,
			loadConfig().extensionSettings,
		),
		controller: new AbortController(),
		granted: true,
		done: Promise.resolve(),
		toolCalls: new Map(),
		startedTools: new Set(),
	};
	const content: AgentInputItem[] = [
		{
			id,
			role: "user",
			content: images?.length
				? [
						{ type: "input_text", text },
						...images.map((image) => ({
							type: "input_image" as const,
							image: `data:${image.mimeType};base64,${image.data}`,
						})),
					]
				: text,
		},
	];
	const message: TranscriptMessage = {
		id,
		role: "user",
		content: images?.length ? [{ type: "text", text }, ...images] : text,
		timestamp: Date.now(),
	};
	const queuedInput = entry.store.record.queue.some((input) => input.id === id);
	const firstSeq = entry.store.record.eventSeq + 1;
	entry.store.update((record) => {
		const existing = record.messages.findIndex((item) => item.id === message.id);
		if (!queuedInput) {
			if (existing === -1) record.messages.push(message);
			else record.messages[existing] = message;
		}
		record.state = {
			...idleState(),
			execution: "running",
			runId: run.id,
			queuedCount: record.queue.length,
		};
		record.eventSeq += queuedInput ? 1 : 2;
	});
	entry.active = run;
	publish(
		{ sessionId, runId: run.id, seq: firstSeq, event: { type: "agent_start" } },
		entry.store.record.workspaceId,
	);
	if (!queuedInput)
		publish(
			{ sessionId, runId: run.id, seq: firstSeq + 1, event: { type: "message_end", message } },
			entry.store.record.workspaceId,
		);
	notifyState(entry);
	run.done = entry.summaryDone
		? entry.summaryDone.then(() => executeRun(entry, run, content))
		: executeRun(entry, run, content);
	return run.done;
}
export async function abortSession(sessionId: string): Promise<void> {
	const entry = mustGet(sessionId);
	entry.summaryController?.abort();
	const run = entry.active;
	if (!run) {
		await entry.summaryDone;
		return;
	}
	entry.stopping = true;
	run.granted = false;
	run.controller.abort();
	run.approval?.reject(new Error("Run cancelled"));
	run.toolResponse?.reject(new Error("Run cancelled"));
	try {
		await run.done;
	} finally {
		delete entry.stopping;
	}
}
export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}
export function getSessionWorkspaceId(sessionId: string): string | undefined {
	return sessions.get(sessionId)?.store.record.workspaceId;
}
export function liveSessionIdsOf(workspaceId?: string): string[] {
	return [...sessions]
		.filter(
			([, entry]) => workspaceId === undefined || entry.store.record.workspaceId === workspaceId,
		)
		.map(([sessionId]) => sessionId);
}
export function isSessionStreaming(sessionId: string): boolean {
	return !!sessions.get(sessionId)?.active;
}
export function getSessionState(sessionId: string): SessionState {
	return structuredClone(mustGet(sessionId).store.record.state);
}
export async function ensureSessionAttached(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<boolean> {
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(workspaceId)
	)
		return false;
	const existing = sessions.get(sessionId);
	if (existing) {
		await existing.active?.ready;
		return (
			existing.store.record.workspaceId === workspaceId &&
			existing.store.record.cwd === resolve(cwd)
		);
	}
	const record = readSessionRecord(sessionId);
	if (!record || record.workspaceId !== workspaceId || record.cwd !== resolve(cwd)) return false;
	const entry: Entry = { store: new PersistentSession(record) };
	sessions.set(sessionId, entry);
	observeStore(entry);
	const interruptedEffects = Object.entries(record.effects).filter(
		([, effect]) => effect.status !== "completed" && effect.runId === record.state.runId,
	);
	const checkpoint = record.runCheckpoint;
	if (
		checkpoint?.granted &&
		interruptedEffects.length === 0 &&
		(record.pendingApproval || record.pendingToolResponse || record.state.execution === "running")
	) {
		const run: ActiveRun = {
			id: checkpoint.runId,
			enabledExtensions: checkpoint.enabledExtensions,
			controller: new AbortController(),
			granted: true,
			done: Promise.resolve(),
			toolCalls: new Map(),
			startedTools: new Set(),
		};
		run.ready = new Promise((resolveReady) => {
			run.markReady = resolveReady;
		});
		entry.active = run;
		run.done = executeRun(entry, run, [], checkpoint.checkpoint);
		await run.ready;
	} else if (
		record.state.execution === "running" ||
		record.pendingApproval ||
		record.pendingToolResponse
	) {
		entry.store.update((current) => {
			current.state.execution = "idle";
			current.state.needsInput = null;
			current.state.completion = {
				completionId: current.state.runId ?? randomUUID(),
				outcome: "interrupted",
			};
			current.state.completionUnread = true;
			for (const queued of current.queue) queued.state = "pending";
			for (const [, effect] of Object.entries(current.effects))
				if (effect.status === "started") effect.status = "unknown";
			delete current.pendingApproval;
			delete current.pendingToolResponse;
			delete current.runCheckpoint;
		});
		for (const [callId, effect] of interruptedEffects)
			recordToolResult(
				entry,
				callId,
				effect.name,
				"Operation interrupted; its result is unknown. Inspect the worktree before retrying.",
				true,
				false,
			);
	}
	if (!entry.active && record.state.runId) {
		for (const [callId, effect] of Object.entries(entry.store.record.effects)) {
			if (effect.runId !== record.state.runId) continue;
			const items: AgentInputItem[] = [];
			if (
				!entry.store.record.history.some(
					(item) => item.type === "function_call" && item.callId === callId,
				)
			)
				items.push({
					type: "function_call",
					callId,
					name: effect.name,
					arguments: JSON.stringify(effect.arguments),
					status: "completed",
				});
			if (
				!entry.store.record.history.some(
					(item) => item.type === "function_call_result" && item.callId === callId,
				)
			)
				items.push({
					type: "function_call_result",
					callId,
					name: effect.name,
					status: "completed",
					output:
						effect.result ??
						"Operation interrupted; its result is unknown. Inspect the worktree before retrying.",
				});
			if (items.length) await entry.store.addItems(items);
		}
	}
	flush(entry);
	return true;
}
export async function getSessionMessages(sessionId: string, workspaceId: string, cwd: string) {
	if (!(await ensureSessionAttached(sessionId, workspaceId, cwd)))
		throw new Error("Unknown session in this workspace");
	const entry = mustGet(sessionId);
	return {
		summary: summaryOf(entry),
		messages: structuredClone(entry.store.record.messages),
		eventSeq: entry.store.record.eventSeq,
	};
}
export async function listSessions(workspaceId: string, cwd: string): Promise<SessionSummary[]> {
	const records = listSessionRecords().filter(
		(record) => record.workspaceId === workspaceId && record.cwd === resolve(cwd),
	);
	return records
		.map((record) =>
			summaryOf(sessions.get(record.sessionId) ?? { store: new PersistentSession(record) }),
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
export interface SessionStateWorkspace {
	id: string;
	projectId: string;
	cwd: string;
}
export async function listSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<SessionStateRecord[]> {
	const records: SessionStateRecord[] = [];
	for (const workspace of workspaces)
		for (const summary of await listSessions(workspace.id, workspace.cwd))
			records.push({
				sessionId: summary.sessionId,
				workspaceId: workspace.id,
				projectId: workspace.projectId,
				state: summary.state ?? idleState(),
				title: summary.title,
				...(summary.firstPrompt ? { firstPrompt: summary.firstPrompt } : {}),
			});
	return records;
}
export async function initializeSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<void> {
	for (const state of await listSessionStates(workspaces)) publishState(state);
}
export function renameSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
	name: string,
	options: { onlyIfUnnamed?: boolean } = {},
): Promise<boolean> {
	const title = normalizeSessionTitle(name);
	if (!title) return Promise.reject(new Error("Invalid session title"));
	return ensureSessionAttached(sessionId, workspaceId, cwd).then((attached) => {
		if (!attached) throw new Error("Unknown session");
		if (closingSessions.has(sessionId) || deletingSessions.has(sessionId))
			throw new Error("Session is closing");
		const entry = mustGet(sessionId);
		if (options.onlyIfUnnamed && entry.store.record.title?.trim()) return false;
		if (entry.store.record.title === title) return true;
		entry.store.update((record) => {
			record.title = title;
		});
		emit(entry, { type: "session_info_changed", name: title });
		notifyState(entry);
		return true;
	});
}
export async function setSessionModel(sessionId: string, model: WireModel): Promise<WireModel> {
	const entry = mustGet(sessionId);
	if (entry.active) throw new Error("Stop the active run before changing its model");
	const configured = (await listAvailableModels()).find(
		(candidate) => candidate.id === model.id && candidate.provider === model.provider,
	);
	if (!configured) throw new Error("Unknown model");
	entry.store.update((record) => {
		record.model = configured;
		if (!configured.thinkingLevels.includes(record.thinkingLevel)) record.thinkingLevel = "off";
	});
	return configured;
}
export function setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
	const entry = mustGet(sessionId);
	if (entry.active) throw new Error("Stop the active run before changing reasoning");
	if (!entry.store.record.model?.thinkingLevels.includes(level))
		throw new Error("Unsupported reasoning level");
	entry.store.update((record) => {
		record.thinkingLevel = level;
	});
	emit(entry, { type: "thinking_level_changed", level });
}
export function acknowledgeCompletion(
	sessionId: string,
	completionId: string,
): { acknowledged: boolean; record: SessionStateRecord } {
	const entry = mustGet(sessionId);
	const acknowledged =
		entry.store.record.state.completion?.completionId === completionId &&
		entry.store.record.state.completionUnread;
	if (acknowledged) {
		entry.store.update((record) => {
			record.state.completionUnread = false;
		});
		notifyState(entry);
	}
	return { acknowledged, record: stateRecord(entry) };
}
export async function markWorkspaceRead(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord[]> {
	const result: SessionStateRecord[] = [];
	for (const summary of await listSessions(workspace.id, workspace.cwd)) {
		if (!summary.state?.completion || !summary.state.completionUnread) continue;
		await ensureSessionAttached(summary.sessionId, workspace.id, workspace.cwd);
		result.push(
			acknowledgeCompletion(summary.sessionId, summary.state.completion.completionId).record,
		);
	}
	return result;
}
export async function markWorkspaceUnread(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord | null> {
	for (const summary of await listSessions(workspace.id, workspace.cwd)) {
		if (
			!summary.state?.completion ||
			summary.state.completionUnread ||
			summary.state.completion.outcome === "cancelled" ||
			summary.state.execution === "running"
		)
			continue;
		await ensureSessionAttached(summary.sessionId, workspace.id, workspace.cwd);
		const entry = mustGet(summary.sessionId);
		entry.store.update((record) => {
			record.state.completionUnread = true;
		});
		notifyState(entry);
		return stateRecord(entry);
	}
	return null;
}
export function getSessionStats(sessionId: string): SessionStats {
	const entry = mustGet(sessionId);
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

	for (const message of entry.store.record.messages)
		if (message.role === "assistant") {
			tokens.input += message.usage.input;
			tokens.output += message.usage.output;
			tokens.cacheRead += message.usage.cacheRead;
			tokens.cacheWrite += message.usage.cacheWrite;
			tokens.total += message.usage.totalTokens;
		}
	for (const receipt of Object.values(entry.store.record.summaryOperations)) {
		if (!receipt.usage) continue;
		tokens.input += receipt.usage.input;
		tokens.output += receipt.usage.output;
		tokens.cacheRead += receipt.usage.cacheRead;
		tokens.cacheWrite += receipt.usage.cacheWrite;
		tokens.total += receipt.usage.total;
	}
	return { sessionId, totalMessages: entry.store.record.messages.length, tokens, cost: null };
}
export async function readFinalAssistantTexts(
	workspaceId: string,
	cwd: string,
	ids: readonly string[],
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	for (const id of ids) {
		const record = sessions.get(id)?.store.record ?? readSessionRecord(id);
		const message =
			record?.workspaceId === workspaceId && record.cwd === resolve(cwd)
				? record.messages.findLast(
						(item) => item.role === "assistant" && textOf(item.content).trim(),
					)
				: undefined;
		result.set(id, message?.role === "assistant" ? textOf(message.content) : null);
	}
	return result;
}
export async function removeSession(sessionId: string): Promise<void> {
	const entry = sessions.get(sessionId);
	if (!entry) return;
	closingSessions.add(sessionId);
	try {
		if (
			entry.active &&
			(entry.store.record.pendingApproval || entry.store.record.pendingToolResponse)
		) {
			const run = entry.active;
			run.suspended = true;
			run.granted = false;
			run.controller.abort();
			run.approval?.reject(new Error("Approval saved for continuation"));
			run.toolResponse?.reject(new Error("Tool response saved for continuation"));
			await run.done;
		} else await abortSession(sessionId);
		await releaseSessionResources?.(sessionId);
		flush(entry);
		sessions.delete(sessionId);
	} finally {
		closingSessions.delete(sessionId);
	}
}
export async function deleteSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<void> {
	const record = sessions.get(sessionId)?.store.record ?? readSessionRecord(sessionId);
	if (!record || record.workspaceId !== workspaceId || record.cwd !== resolve(cwd))
		throw new Error("Unknown session in this workspace");
	if (deletingSessions.has(sessionId)) throw new Error("Session deletion is already in progress");
	deletingSessions.add(sessionId);
	try {
		await removeSession(sessionId);
		await trashFile(sessionRecordPath(sessionId));
		publishDeleted({ sessionId, workspaceId });
	} finally {
		deletingSessions.delete(sessionId);
	}
}
export async function removeWorkspaceSessions(workspaceId: string, cwd?: string): Promise<void> {
	for (const record of listSessionRecords())
		if (record.workspaceId === workspaceId && (cwd === undefined || record.cwd === resolve(cwd)))
			await deleteSession(record.sessionId, workspaceId, record.cwd);
}
export async function closeWorkspaceSessions<T>(
	workspaceId: string,
	operation: () => Promise<T>,
): Promise<T> {
	if (closingWorkspaces.has(workspaceId)) throw new Error("Workspace is closing");
	closingWorkspaces.add(workspaceId);
	try {
		for (const [id, entry] of sessions)
			if (entry.store.record.workspaceId === workspaceId) await removeSession(id);
		return await operation();
	} finally {
		closingWorkspaces.delete(workspaceId);
	}
}
export async function settleSessionsForShutdown(): Promise<void> {
	await Promise.all([...sessions.keys()].map((id) => removeSession(id)));
}
export function disposeAllSessions(): void {
	for (const entry of sessions.values()) {
		entry.summaryController?.abort();
		if (entry.active) {
			entry.active.suspended = true;
			entry.active.granted = false;
			entry.active.controller.abort();
			entry.active.approval?.reject(new Error("Host stopped"));
			entry.active.toolResponse?.reject(new Error("Host stopped"));
		}
		if (entry.flush) clearTimeout(entry.flush);
	}
	sessions.clear();
}

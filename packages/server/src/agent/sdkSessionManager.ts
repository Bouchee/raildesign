import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	Agent,
	type AgentInputItem,
	MaxTurnsExceededError,
	Runner,
	type RunState,
	type RunStreamEvent,
} from "@openai/agents";
import type {
	AgentSettlement,
	AssistantMessage,
	ExtUiRequest,
	ExtUiResponse,
	ImageContent,
	SessionCreatedPayload,
	SessionDeletedPayload,
	SessionEvent,
	SessionEventPayload,
	SessionState,
	SessionStateRecord,
	SessionStats,
	SessionSummary,
	ThinkingLevel,
	TranscriptMessage,
	WireModel,
} from "@thinkrail/contracts";
import { firstPromptOfTexts, normalizeSessionTitle } from "@thinkrail/contracts";
import { logger } from "../log";
import { loadWorkspaces } from "../persistence";
import { trashFile } from "../trash";
import {
	createConfiguredModel,
	listAvailableModels,
	modelOutputBudget,
	responsesClientSettings,
} from "./modelConfiguration";
import { workspaceTools } from "./sdkTools";
import {
	type ApprovalRequest,
	listSessionRecords,
	PersistentSession,
	readSessionRecord,
	sessionRecordPath,
} from "./sessionStore";

const log = logger("agent");
interface ActiveRun {
	id: string;
	controller: AbortController;
	granted: boolean;
	done: Promise<void>;
	assistantId?: string;
	toolCalls: Map<string, { name: string; arguments: Record<string, unknown>; failed: boolean }>;
	startedTools: Set<string>;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheRead: number;
		cacheWrite: number;
	};
	approval?: {
		request: ApprovalRequest;
		resolve: (approved: boolean) => void;
		reject: (error: Error) => void;
	};
}
interface Entry {
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
): void {
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
		content: [{ type: "text", text: output }],
		isError,
		timestamp: previous?.timestamp ?? Date.now(),
	};
	appendMessage(entry, message);
	emit(entry, {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: name,
		result: { content: message.content },
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
	const request: ApprovalRequest = {
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
		record.state.needsInput = { interactionId: request.id, kind: "dialog", request };
	});
	publishDialog(request);
	notifyState(entry);
	return approved;
}

export function resolveExtUi(response: ExtUiResponse): void {
	const entry = mustGet(response.sessionId);
	const decision = entry.store.record.decisions[response.id];
	if (decision) {
		if (
			decision.runId !== response.runId ||
			decision.revision !== response.revision ||
			decision.value !== response.value
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
		typeof response.value !== "boolean"
	)
		throw new Error("Approval is stale or belongs to a different run");
	assertActive(entry, run);
	entry.store.update((record) => {
		record.decisions[response.id] = {
			runId: run.id,
			revision: response.revision,
			value: response.value === true,
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

async function executeRun(entry: Entry, run: ActiveRun, input: AgentInputItem[]): Promise<void> {
	let terminal: AgentSettlement = { stopReason: "stop" };
	try {
		const selected = entry.store.record.model;
		const model = selected
			? (await listAvailableModels()).find(
					(candidate) => candidate.id === selected.id && candidate.provider === selected.provider,
				)
			: undefined;
		if (!model) throw new Error("Configure a Responses-compatible model before sending a message");
		assertActive(entry, run);
		const agent = new Agent({
			name: "RailDesign",
			instructions: `You are RailDesign, a coding assistant. Work only in the assigned worktree: ${entry.store.record.cwd}. Use read and search to inspect files. Use apply_patch for edits and bash to run project checks. Request approval for commands and edits. A denied operation is not permission to try another route. Report actual checks and remaining limits.`,
			model: createConfiguredModel(model, entry.store.record.sessionId),
			tools: workspaceTools(
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
			addToolCall(entry, run, details.toolCall);
			run.startedTools.add(details.toolCall.callId);
			const call = run.toolCalls.get(details.toolCall.callId);
			emit(entry, {
				type: "tool_execution_start",
				toolCallId: details.toolCall.callId,
				toolName: details.toolCall.name,
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
		const runner = new Runner({ tracingDisabled: true });
		let next: AgentInputItem[] | RunState<unknown, Agent<unknown, "text">> = input;
		while (true) {
			assertActive(entry, run);
			const stream = await startStream(runner, agent, next, entry.store, run.controller.signal);
			for await (const event of stream) projectStream(entry, run, event);
			await stream.completed;
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
				const approved = await waitForApproval(entry, run, stream.state, interruption.rawItem);
				assertActive(entry, run);
				if (approved) stream.state.approve(interruption);
				else {
					const call = run.toolCalls.get(interruption.rawItem.callId);
					if (call) call.failed = true;
					stream.state.reject(interruption);
				}
			}
			next = stream.state;
		}
	} catch (error) {
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
				recordToolResult(entry, callId, call.name, output, true);
				if (
					!entry.store.record.history.some(
						(item) => item.type === "function_call_result" && item.callId === callId,
					)
				)
					await entry.store.addItems([
						{ type: "function_call_result", callId, name: call.name, status: "incomplete", output },
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
			emit(entry, { type: "agent_end", messages: entry.store.record.messages, willRetry: false });
			emit(entry, { type: "agent_settled", terminal });
		} finally {
			run.granted = false;
			run.controller.abort();
			delete entry.active;
			notifyState(entry);
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
			version: 1,
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
		}),
	};
	flush(entry);
	sessions.set(sessionId, entry);
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
): Promise<void> {
	const entry = mustGet(sessionId);
	if (typeof text !== "string") throw new Error("Message must be text");
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (entry.active) throw new Error("A run is already active in this session");
	if (!text.trim() && !images?.length) throw new Error("Message is empty");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	const id = randomUUID();
	const run: ActiveRun = {
		id: randomUUID(),
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
	const firstSeq = entry.store.record.eventSeq + 1;
	entry.store.update((record) => {
		record.messages.push(message);
		record.state = { ...idleState(), execution: "running", runId: run.id };
		record.eventSeq += 2;
	});
	entry.active = run;
	publish(
		{ sessionId, runId: run.id, seq: firstSeq, event: { type: "agent_start" } },
		entry.store.record.workspaceId,
	);
	publish(
		{ sessionId, runId: run.id, seq: firstSeq + 1, event: { type: "message_end", message } },
		entry.store.record.workspaceId,
	);
	notifyState(entry);
	run.done = executeRun(entry, run, content);
	return run.done;
}
export async function abortSession(sessionId: string): Promise<void> {
	const entry = mustGet(sessionId);
	const run = entry.active;
	if (!run) return;
	run.granted = false;
	run.controller.abort();
	run.approval?.reject(new Error("Run cancelled"));
	await run.done;
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
	if (existing)
		return (
			existing.store.record.workspaceId === workspaceId &&
			existing.store.record.cwd === resolve(cwd)
		);
	const record = readSessionRecord(sessionId);
	if (!record || record.workspaceId !== workspaceId || record.cwd !== resolve(cwd)) return false;
	if (record.state.execution === "running" || record.pendingApproval) {
		record.state.execution = "idle";
		record.state.needsInput = null;
		record.state.completion = {
			completionId: record.state.runId ?? randomUUID(),
			outcome: "interrupted",
		};
		record.state.completionUnread = true;
		delete record.pendingApproval;
	}
	const entry: Entry = { store: new PersistentSession(record) };
	flush(entry);
	sessions.set(sessionId, entry);
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
		await abortSession(sessionId);
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
		if (entry.active) {
			entry.active.granted = false;
			entry.active.controller.abort();
			entry.active.approval?.reject(new Error("Host stopped"));
		}
		if (entry.flush) clearTimeout(entry.flush);
	}
	sessions.clear();
}

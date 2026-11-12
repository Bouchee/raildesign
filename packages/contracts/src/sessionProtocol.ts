export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
	id?: string;
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	id?: string;
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage<T = unknown> {
	id?: string;
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: T;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| {
			type: "text_start" | "thinking_start" | "toolcall_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "text_delta" | "thinking_delta" | "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end" | "thinking_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: StopReason; message: AssistantMessage }
	| { type: "error"; reason: StopReason; error: AssistantMessage };

import type { ProviderAuthKind, ProviderWarning } from "./domain";

const NON_EXECUTABLE_TOOL_CALL_STOP_REASONS: ReadonlySet<string> = new Set([
	"error",
	"aborted",
	"length",
]);

export function assistantToolCallsAreExecutable(stopReason: string | undefined): boolean {
	return stopReason === undefined || !NON_EXECUTABLE_TOOL_CALL_STOP_REASONS.has(stopReason);
}

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevels: ThinkingLevel[];
	cost?: { input: number; output: number };
	input?: ("text" | "image")[];
	auth?: WireModelAuth;
}

export interface WireModelAuth {
	kind: ProviderAuthKind;
	/** Account, plan, or variable name behind the connection (e.g. `ANTHROPIC_API_KEY`), when configured. */
	detail?: string;
}

/** `WireModel` identity is `{provider, id}`; every other field is a catalog snapshot that may lag. */
export function sameModel(
	a: Pick<WireModel, "provider" | "id"> | null | undefined,
	b: Pick<WireModel, "provider" | "id"> | null | undefined,
): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export interface RefreshedModels {
	models: WireModel[];
	complete: boolean;
}

export interface AgentSettlement {
	stopReason: StopReason;
	errorMessage?: string;
}

export type SessionInputKind = "tool-response" | "dialog";

export type SessionInputState =
	| { interactionId: string; kind: "tool-response"; toolCallId: string }
	| {
			interactionId: string;
			kind: "dialog";
			request: Extract<ExtUiRequest, { kind: "select" | "confirm" | "input" | "editor" }>;
	  };

export type SessionCompletion =
	| { completionId: string; outcome: "succeeded" | "interrupted" | "cancelled" }
	| { completionId: string; outcome: "failed"; failure: "error" | "length" };

export interface SessionState {
	execution: "idle" | "running";
	runId: string | null;
	needsInput: SessionInputState | null;
	completion: SessionCompletion | null;
	completionUnread: boolean;
	queuedCount: number;
	backgroundWork: boolean;
}

export function isSessionWorking(state: SessionState): boolean {
	return state.execution === "running" || state.backgroundWork === true;
}

export function canMarkCompletionUnread(state: SessionState): boolean {
	return (
		!isSessionWorking(state) &&
		state.needsInput === null &&
		state.completion !== null &&
		state.completion.outcome !== "cancelled" &&
		!state.completionUnread
	);
}

export type SessionEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "message_start" | "message_end"; message: WireAgentMessage }
	| {
			type: "message_update";
			message: WireAgentMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "turn_end"; message: WireAgentMessage; toolResults: ToolResultMessage[] }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| { type: "agent_end"; messages: WireAgentMessage[]; willRetry: boolean }
	| { type: "agent_settled"; terminal: AgentSettlement | null }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
			hasImages?: true;
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "entry_appended"; entryType: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionEndResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

export interface CompactionEndResult {
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

export interface SessionEventPayload {
	sessionId: string;
	runId: string | null;
	seq: number;
	event: SessionEvent;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface SessionStats {
	sessionId: string;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number | null;
	contextUsage?: ContextUsage;
}

export type QueueLane = "steering" | "followUp";

export interface SessionQueueState {
	steering: readonly string[];
	followUp: readonly string[];
	hasImages?: true;
}

export interface QueuedMessageContent {
	text: string;
	images?: readonly ImageContent[];
}

export interface SessionQueueContent {
	steering: readonly QueuedMessageContent[];
	followUp: readonly QueuedMessageContent[];
}

export interface RemovedQueuedMessage {
	removed: QueuedMessageContent | null;
	queue: SessionQueueState;
}

export interface SessionSummary {
	eventSeq?: number;
	sessionId: string;
	workspaceId: string;
	title: string;
	firstPrompt?: string;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	messageCount: number;
	updatedAt: number;
	live: boolean;
	openTodos?: number;
	lastSettlement?: AgentSettlement | null;
	queue?: SessionQueueState;
	state?: SessionState;
}

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandSourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SlashCommandSourceInfo;
}

export type SkillDecision = "load" | "untrusted" | "pending-ack" | "disabled";

export interface SkillCatalogEntry {
	name: string;
	description?: string;
	sourceInfo: SlashCommandSourceInfo;
	gated: boolean;
	plugin?: string;
	group: string;
	decision: SkillDecision;
	/** `disable-model-invocation`: callable only as `/skill:`, never listed in the prompt. */
	manualOnly?: boolean;
}

/** The tool call a dialog is about; absent when it is not tied to one (a command, startup, parallel calls). */
interface ExtUiDialogAnchor {
	runId?: string;
	revision?: number;
	toolCallId?: string;
	/** The input that call will run with, as the asking host saw it — shown in full inside the prompt. */
	toolInput?: Record<string, unknown>;
}

export type ExtUiRequest =
	| ({
			id: string;
			sessionId: string;
			kind: "select";
			title: string;
			options: string[];
	  } & ExtUiDialogAnchor)
	| ({
			id: string;
			sessionId: string;
			kind: "confirm";
			title: string;
			message: string;
	  } & ExtUiDialogAnchor)
	| ({
			id: string;
			sessionId: string;
			kind: "input";
			title: string;
			placeholder?: string;
	  } & ExtUiDialogAnchor)
	| ({
			id: string;
			sessionId: string;
			kind: "editor";
			title: string;
			prefill?: string;
	  } & ExtUiDialogAnchor)
	| {
			id: string;
			sessionId: string;
			kind: "notify";
			message: string;
			level: "info" | "warning" | "error";
	  }
	| { id: string; sessionId: string; kind: "setStatus"; key: string; text: string | null }
	| { id: string; sessionId: string; kind: "setWidget"; key: string; content: string[] | null }
	| { id: string; sessionId: string; kind: "setTitle"; title: string }
	| { id: string; sessionId: string; kind: "notice"; notice: ProviderWarning }
	| { id: string; sessionId: string; kind: "dismiss" };

export interface ExtUiResponse {
	sessionId: string;
	runId: string;
	revision: number;
	id: string;
	value: string | boolean | null;
}

export interface ToolResponsePendingDetails {
	kind: "ack";
}

export interface ToolResponseDetails {
	toolCallId: string;
	response: unknown;
}

export interface WireCustomMessage<T = unknown> {
	id?: string;
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface WireCompactionSummary {
	id?: string;
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export type TranscriptMessage = Message | WireCustomMessage | WireCompactionSummary;

export interface WireBranchSummary {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface WireBashExecution {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export type WireAgentMessage = TranscriptMessage | WireBranchSummary | WireBashExecution;

const TRANSCRIPT_MESSAGE_ROLES: ReadonlySet<string> = new Set([
	"user",
	"assistant",
	"toolResult",
	"custom",
	"compactionSummary",
]);

export function isTranscriptMessageRole(role: string): boolean {
	return TRANSCRIPT_MESSAGE_ROLES.has(role);
}

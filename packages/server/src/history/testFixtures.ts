import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	AssistantMessage,
	SessionState,
	StopReason,
	ToolResultMessage,
	TranscriptMessage,
} from "@thinkrail/contracts";

import type { SessionRecord } from "../agent";

type FixtureAssistantMessage = {
	role: "assistant";
	timestamp: number;
	stopReason?: StopReason;
	errorMessage?: string;
} & ({ text: string; content?: never } | { text?: never; content: AssistantMessage["content"] });

export type FixtureMessage =
	| { role: "user"; text: string; timestamp: number }
	| FixtureAssistantMessage
	| Extract<TranscriptMessage, { role: "custom" | "compactionSummary" }>
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ToolResultMessage["content"];
			details?: unknown;
			isError: boolean;
			timestamp: number;
	  };

export function writeFixtureSession(
	dir: string,
	opts: {
		id?: string;
		workspaceId?: string;
		cwd: string;
		name?: string;
		messages: FixtureMessage[];
		state?: SessionState;
		updatedAt?: number;
	},
): { id: string; path: string } {
	const sessionId = opts.id ?? randomUUID();
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error("Invalid fixture session ID");
	const messages: TranscriptMessage[] = opts.messages.map((message, index) => {
		const id = `${sessionId}-m${index}`;
		if (message.role === "user")
			return { id, role: "user", content: message.text, timestamp: message.timestamp };
		if (message.role === "toolResult") return { ...message, id };
		if (message.role === "custom" || message.role === "compactionSummary")
			return { ...message, id };
		const content = message.content ?? [{ type: "text" as const, text: message.text }];
		return {
			id,
			role: "assistant",
			content,
			timestamp: message.timestamp,
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: message.stopReason ?? "stop",
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		};
	});
	const record: SessionRecord = {
		version: 2,
		sessionId,
		workspaceId: opts.workspaceId ?? "fixture",
		cwd: resolve(opts.cwd),
		...(opts.name === undefined ? {} : { title: opts.name }),
		model: null,
		thinkingLevel: "off",
		eventSeq: 0,
		revision: 0,
		history: [],
		inputItems: {},
		historyOperations: {},
		summaryOperations: {},
		retiredInputIds: [],
		queue: [],
		effects: {},
		messages,
		decisions: {},
		toolResponses: {},
		updatedAt: opts.updatedAt ?? Math.max(0, ...messages.map((message) => message.timestamp)),
		state: opts.state ?? {
			execution: "idle",
			runId: null,
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	};
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${sessionId}.json`);
	const temporary = join(dir, `.${sessionId}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return { id: sessionId, path };
}

export function sessionDirFor(dataDirectory: string): string {
	return join(resolve(dataDirectory), "sessions");
}

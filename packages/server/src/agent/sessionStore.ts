import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentInputItem,
	protocol,
	type Session,
	type SessionHistoryTransaction,
	type SessionHistoryTransactionArgs,
} from "@openai/agents";
import type {
	ExtUiRequest,
	ImageContent,
	SessionState,
	ThinkingLevel,
	TranscriptMessage,
	WireModel,
} from "@thinkrail/contracts";
import { z } from "zod";
import { logger } from "../log";
import { dataDir } from "../persistence";
import { type CompactOptions, type CompactResult, compactSession } from "./sessionSummary";

const log = logger("agent");

export type ApprovalRequest = Extract<ExtUiRequest, { kind: "confirm" }> & {
	runId: string;
	revision: number;
	toolCallId: string;
};

export interface StoredInput {
	id: string;
	text: string;
	images?: readonly ImageContent[] | undefined;
	kind: "steering" | "followUp";
	state: "pending" | "staged";
	error?: string | undefined;
}

export interface EffectRecord {
	runId: string;
	name: string;
	arguments: Record<string, unknown>;
	status: "started" | "completed" | "unknown";
	result?: string | undefined;
	isError?: boolean | undefined;
}

export interface SummaryReceipt {
	force: boolean;
	instructions: string;
	sourceRevision: number;
	beforeTokens: number;
	afterTokens: number;
	usage?:
		| { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
		| undefined;
}

export interface SessionRecord {
	version: 2;
	sessionId: string;
	workspaceId: string;
	cwd: string;
	title?: string | undefined;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
	eventSeq: number;
	revision: number;
	history: AgentInputItem[];
	inputItems: Record<string, AgentInputItem>;
	historyOperations: Record<string, SessionHistoryTransaction>;
	summaryOperations: Record<string, SummaryReceipt>;
	retiredInputIds: string[];
	queue: StoredInput[];
	effects: Record<string, EffectRecord>;
	messages: TranscriptMessage[];
	state: SessionState;
	updatedAt: number;
	modelContextTokens?: number | undefined;
	pendingApproval?: { request: ApprovalRequest; checkpoint: string } | undefined;
	pendingToolResponse?:
		| {
				id: string;
				sessionId: string;
				runId: string;
				revision: number;
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				checkpoint: string;
		  }
		| undefined;
	toolResponses: Record<
		string,
		{ runId: string; revision: number; toolCallId: string; response: unknown }
	>;
	runCheckpoint?:
		| {
				runId: string;
				checkpoint: string;
				granted: boolean;
				enabledExtensions: { name: string; settings: Record<string, boolean> }[];
		  }
		| undefined;
	decisions: Record<
		string,
		{ runId: string; revision: number; toolCallId: string; value: boolean }
	>;
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const textSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	textSignature: z.string().optional(),
});
const imageSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const usageSchema = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	cacheWrite: z.number().nonnegative(),
	totalTokens: z.number().nonnegative(),
	cost: z.object({
		input: z.number(),
		output: z.number(),
		cacheRead: z.number(),
		cacheWrite: z.number(),
		total: z.number(),
	}),
});
const messageBase = z.object({ id: z.string().optional(), timestamp: z.number().finite() });
const transcriptSchema = z.discriminatedUnion("role", [
	messageBase.extend({
		role: z.literal("user"),
		content: z.union([z.string(), z.array(z.union([textSchema, imageSchema]))]),
	}),
	messageBase.extend({
		role: z.literal("assistant"),
		api: z.string(),
		provider: z.string(),
		model: z.string(),
		content: z.array(
			z.union([
				textSchema,
				z.object({ type: z.literal("thinking"), thinking: z.string() }),
				z.object({
					type: z.literal("toolCall"),
					id: z.string(),
					name: z.string(),
					arguments: z.record(z.string(), z.unknown()),
				}),
			]),
		),
		usage: usageSchema,
		stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
		errorMessage: z.string().optional(),
	}),
	messageBase.extend({
		role: z.literal("toolResult"),
		toolCallId: z.string(),
		toolName: z.string(),
		content: z.array(z.union([textSchema, imageSchema])),
		isError: z.boolean(),
	}),
	messageBase.extend({
		role: z.literal("custom"),
		customType: z.string(),
		content: z.union([z.string(), z.array(z.union([textSchema, imageSchema]))]),
		display: z.boolean(),
	}),
	messageBase.extend({
		role: z.literal("compactionSummary"),
		summary: z.string(),
		tokensBefore: z.number(),
	}),
]);
const wireModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.string(),
	contextWindow: z.number().nonnegative(),
	reasoning: z.boolean(),
	thinkingLevels: z.array(thinkingSchema),
});
const completionSchema = z.union([
	z.object({
		completionId: z.string(),
		outcome: z.enum(["succeeded", "interrupted", "cancelled"]),
	}),
	z.object({
		completionId: z.string(),
		outcome: z.literal("failed"),
		failure: z.enum(["error", "length"]),
	}),
]);
const approvalSchema = z.object({
	id: z.string(),
	sessionId: idSchema,
	runId: z.string(),
	revision: z.number().int().nonnegative(),
	toolCallId: z.string(),
	kind: z.literal("confirm"),
	title: z.string(),
	message: z.string(),
});
const stateSchema = z.object({
	execution: z.enum(["idle", "running"]),
	runId: z.string().nullable(),
	needsInput: z.union([
		z.null(),
		z.object({ interactionId: z.string(), kind: z.literal("dialog"), request: approvalSchema }),
		z.object({
			interactionId: z.string(),
			kind: z.literal("tool-response"),
			toolCallId: z.string(),
			runId: z.string(),
			revision: z.number().int().nonnegative(),
		}),
	]),
	completion: completionSchema.nullable(),
	completionUnread: z.boolean(),
	queuedCount: z.number().int().nonnegative(),
	backgroundWork: z.boolean(),
});
const recordSchema = z.object({
	version: z.literal(2),
	sessionId: idSchema,
	workspaceId: z.string().min(1),
	cwd: z.string().min(1),
	title: z.string().optional(),
	model: z.custom<WireModel | null>((v) => v === null || wireModelSchema.safeParse(v).success),
	thinkingLevel: thinkingSchema,
	eventSeq: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
	history: z.array(protocol.ModelItem),
	inputItems: z.record(z.string(), protocol.ModelItem),
	historyOperations: z.record(
		z.string(),
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("append_items"), items: z.array(protocol.ModelItem) }),
			z.object({
				type: z.literal("replace_suffix"),
				expectedSuffix: z.array(protocol.ModelItem),
				replacement: z.array(protocol.ModelItem),
			}),
		]),
	),
	summaryOperations: z.record(
		z.string(),
		z.object({
			force: z.boolean(),
			instructions: z.string(),
			sourceRevision: z.number().int().nonnegative(),
			beforeTokens: z.number().int().nonnegative(),
			afterTokens: z.number().int().nonnegative(),
			usage: z
				.object({
					input: z.number().int().nonnegative(),
					output: z.number().int().nonnegative(),
					cacheRead: z.number().int().nonnegative(),
					cacheWrite: z.number().int().nonnegative(),
					total: z.number().int().nonnegative(),
				})
				.optional(),
		}),
	),
	retiredInputIds: z.array(z.string()),
	queue: z.array(
		z.object({
			id: idSchema,
			text: z.string(),
			images: z.array(imageSchema).optional(),
			kind: z.enum(["steering", "followUp"]),
			state: z.enum(["pending", "staged"]),
			error: z.string().optional(),
		}),
	),
	effects: z.record(
		z.string(),
		z.object({
			runId: z.string(),
			name: z.string(),
			arguments: z.record(z.string(), z.unknown()),
			status: z.enum(["started", "completed", "unknown"]),
			result: z.string().optional(),
			isError: z.boolean().optional(),
		}),
	),
	messages: z.array(z.custom<TranscriptMessage>((v) => transcriptSchema.safeParse(v).success)),
	state: z.custom<SessionState>((v) => stateSchema.safeParse(v).success),
	updatedAt: z.number().finite(),
	modelContextTokens: z.number().int().nonnegative().optional(),
	pendingApproval: z
		.custom<SessionRecord["pendingApproval"]>(
			(v) =>
				v === undefined ||
				z.object({ request: approvalSchema, checkpoint: z.string() }).safeParse(v).success,
		)
		.optional(),
	pendingToolResponse: z
		.object({
			id: z.string(),
			sessionId: idSchema,
			runId: z.string(),
			revision: z.number().int().nonnegative(),
			toolCallId: z.string(),
			toolName: z.string(),
			args: z.record(z.string(), z.unknown()),
			checkpoint: z.string(),
		})
		.optional(),
	toolResponses: z.record(
		z.string(),
		z.object({
			runId: z.string(),
			revision: z.number().int().nonnegative(),
			toolCallId: z.string(),
			response: z.unknown(),
		}),
	),
	runCheckpoint: z
		.object({
			runId: z.string(),
			checkpoint: z.string(),
			granted: z.boolean(),
			enabledExtensions: z.array(
				z.object({ name: z.string().min(1), settings: z.record(z.string(), z.boolean()) }),
			),
		})
		.optional(),
	decisions: z.record(
		z.string(),
		z.object({
			runId: z.string(),
			revision: z.number().int(),
			toolCallId: z.string(),
			value: z.boolean(),
		}),
	),
});

export function sessionRecordPath(sessionId: string, directory = dataDir()): string {
	if (!idSchema.safeParse(sessionId).success) throw new Error("Invalid session ID");
	return join(directory, "sessions", `${sessionId}.json`);
}

export function readSessionRecord(sessionId: string): SessionRecord | null {
	try {
		const record = recordSchema.parse(
			JSON.parse(readFileSync(sessionRecordPath(sessionId), "utf8")),
		);
		if (record.sessionId !== sessionId) throw new Error("Session identity does not match its file");
		return record;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export function listSessionRecords(): SessionRecord[] {
	let names: string[];
	try {
		names = readdirSync(join(dataDir(), "sessions"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.flatMap((name) => {
			// One unreadable record must not hide other sessions or stop the host from starting.
			try {
				return readSessionRecord(name.slice(0, -5)) ?? [];
			} catch (error) {
				log.warn(`Skipped unreadable session record ${name}`, error);
				return [];
			}
		});
}

export function writeSessionRecord(record: SessionRecord, root = dataDir()): void {
	recordSchema.parse(record);
	const directory = join(root, "sessions");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temp = join(directory, `.${record.sessionId}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		renameSync(temp, sessionRecordPath(record.sessionId, root));
	} finally {
		rmSync(temp, { force: true });
	}
}

export class PersistentSession implements Session {
	record: SessionRecord;
	onUpdate?: (previous: SessionRecord) => void;
	private readonly directory: string;
	constructor(record: SessionRecord) {
		this.directory = dataDir();
		this.record = record;
	}
	getSessionId(): Promise<string> {
		return Promise.resolve(this.record.sessionId);
	}
	getItems(limit?: number): Promise<AgentInputItem[]> {
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
			throw new Error("Invalid history limit");
		return Promise.resolve(
			structuredClone(
				limit === undefined
					? this.record.history
					: limit === 0
						? []
						: this.record.history.slice(-limit),
			),
		);
	}
	update(change: (record: SessionRecord) => void, expectedRevision = this.record.revision): void {
		if (this.record.revision !== expectedRevision) throw new Error("Session revision changed");
		const previous = this.record;
		const next = structuredClone(this.record);
		change(next);
		next.state.queuedCount = next.queue.length;
		next.revision += 1;
		next.updatedAt = Date.now();
		writeSessionRecord(next, this.directory);
		this.record = next;
		this.onUpdate?.(previous);
	}
	addItems(items: AgentInputItem[]): Promise<void> {
		const detached = snapshotItems(items);
		if (detached.length === 0) return Promise.resolve();
		this.update((record) => {
			appendHistory(record, detached);
		});
		return Promise.resolve();
	}
	applyHistoryTransaction(args: SessionHistoryTransactionArgs): Promise<void> {
		if (!args.operationId.trim()) throw new Error("Invalid history operation ID");
		const transaction: SessionHistoryTransaction =
			args.transaction.type === "append_items"
				? { type: "append_items", items: snapshotItems(args.transaction.items) }
				: {
						type: "replace_suffix",
						expectedSuffix: snapshotItems(args.transaction.expectedSuffix),
						replacement: snapshotItems(args.transaction.replacement),
					};
		const previous = Object.hasOwn(this.record.historyOperations, args.operationId)
			? this.record.historyOperations[args.operationId]
			: undefined;
		if (previous) {
			if (!isDeepStrictEqual(previous, transaction))
				throw new Error("Conflicting history operation");
			return Promise.resolve();
		}
		this.update((record) => {
			if (transaction.type === "replace_suffix") {
				const count = transaction.expectedSuffix.length;
				if (
					count > record.history.length ||
					!isDeepStrictEqual(
						count === 0 ? [] : record.history.slice(-count),
						transaction.expectedSuffix,
					)
				)
					throw new Error("History suffix does not match");
				if (count > 0) record.history.splice(-count);
				appendHistory(record, transaction.replacement);
			} else appendHistory(record, transaction.items);
			record.historyOperations = { ...record.historyOperations, [args.operationId]: transaction };
		});
		return Promise.resolve();
	}
	popItem(): Promise<AgentInputItem | undefined> {
		let popped: AgentInputItem | undefined;
		this.update((record) => {
			popped = record.history.pop();
		});
		return Promise.resolve(structuredClone(popped));
	}
	clearSession(): Promise<void> {
		this.update((record) => {
			record.history = [];
			record.retiredInputIds = [];
		});
		return Promise.resolve();
	}
	compact(options: CompactOptions): Promise<CompactResult> {
		return compactSession(this, options);
	}
}

function snapshotItems(items: AgentInputItem[]): AgentInputItem[] {
	const serialized = JSON.stringify(items, (_key, value: unknown) => {
		if (
			typeof value === "function" ||
			typeof value === "symbol" ||
			typeof value === "bigint" ||
			(typeof value === "number" && !Number.isFinite(value)) ||
			(value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		)
			throw new Error("History metadata must be JSON data");
		return value;
	});
	return z.array(protocol.ModelItem).parse(JSON.parse(serialized));
}

function appendHistory(record: SessionRecord, items: AgentInputItem[]): void {
	const admitted = new Set<string>();
	for (const item of items) {
		const id = "role" in item && item.role === "user" ? item.id : undefined;
		if (id !== undefined) {
			const previous = Object.hasOwn(record.inputItems, id) ? record.inputItems[id] : undefined;
			if (previous && !isDeepStrictEqual(previous, item))
				throw new Error("Conflicting user input ID");
			const queued = record.queue.find((input) => input.id === id);
			if (queued && !record.messages.some((message) => message.id === id))
				record.messages.push({
					id,
					role: "user",
					content: queued.images?.length
						? [{ type: "text", text: queued.text }, ...queued.images]
						: queued.text,
					timestamp: Date.now(),
				});
			const transcript = record.messages.find((message) => message.id === id);
			if (
				transcript &&
				(transcript.role !== "user" ||
					!("role" in item) ||
					item.role !== "user" ||
					!isDeepStrictEqual(transcript.content, transcriptContent(item)))
			)
				throw new Error("Conflicting transcript input ID");
			const current = record.history.find(
				(stored) => "role" in stored && stored.role === "user" && stored.id === id,
			);
			if (current && !isDeepStrictEqual(current, item))
				throw new Error("Conflicting user input ID");
			record.inputItems = { ...record.inputItems, [id]: structuredClone(item) };
			admitted.add(id);
			if (current || record.retiredInputIds.includes(id)) continue;
		}
		record.history.push(structuredClone(item));
	}
	record.queue = record.queue.filter((item) => !admitted.has(item.id));
}

function transcriptContent(item: Extract<AgentInputItem, { role: "user" }>) {
	if (typeof item.content === "string") return item.content;
	return item.content.map((part) => {
		if (part.type === "input_text") return { type: "text", text: part.text };
		if (part.type === "input_image" && typeof part.image === "string") {
			const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.image);
			if (match) return { type: "image", mimeType: match[1], data: match[2] };
		}
		throw new Error("Input content does not match the application transcript");
	});
}

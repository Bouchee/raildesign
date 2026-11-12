import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentInputItem, protocol, type Session } from "@openai/agents";
import type {
	ExtUiRequest,
	SessionState,
	ThinkingLevel,
	TranscriptMessage,
	WireModel,
} from "@thinkrail/contracts";
import { z } from "zod";
import { logger } from "../log";
import { dataDir } from "../persistence";

const log = logger("agent");

export type ApprovalRequest = Extract<ExtUiRequest, { kind: "confirm" }> & {
	runId: string;
	revision: number;
	toolCallId: string;
};

export interface SessionRecord {
	version: 1;
	sessionId: string;
	workspaceId: string;
	cwd: string;
	title?: string | undefined;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
	eventSeq: number;
	revision: number;
	history: AgentInputItem[];
	messages: TranscriptMessage[];
	state: SessionState;
	updatedAt: number;
	pendingApproval?: { request: ApprovalRequest; checkpoint: string } | undefined;
	decisions: Record<string, { runId: string; revision: number; value: boolean }>;
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
		}),
	]),
	completion: completionSchema.nullable(),
	completionUnread: z.boolean(),
	queuedCount: z.number().int().nonnegative(),
	backgroundWork: z.boolean(),
});
const recordSchema = z.object({
	version: z.literal(1),
	sessionId: idSchema,
	workspaceId: z.string().min(1),
	cwd: z.string().min(1),
	title: z.string().optional(),
	model: z.custom<WireModel | null>((v) => v === null || wireModelSchema.safeParse(v).success),
	thinkingLevel: thinkingSchema,
	eventSeq: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
	history: z.array(protocol.ModelItem),
	messages: z.array(z.custom<TranscriptMessage>((v) => transcriptSchema.safeParse(v).success)),
	state: z.custom<SessionState>((v) => stateSchema.safeParse(v).success),
	updatedAt: z.number().finite(),
	pendingApproval: z
		.custom<SessionRecord["pendingApproval"]>(
			(v) =>
				v === undefined ||
				z.object({ request: approvalSchema, checkpoint: z.string() }).safeParse(v).success,
		)
		.optional(),
	decisions: z.record(
		z.string(),
		z.object({ runId: z.string(), revision: z.number().int(), value: z.boolean() }),
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
	update(change: (record: SessionRecord) => void): void {
		const next = structuredClone(this.record);
		change(next);
		next.revision += 1;
		next.updatedAt = Date.now();
		writeSessionRecord(next, this.directory);
		this.record = next;
	}
	addItems(items: AgentInputItem[]): Promise<void> {
		this.update((record) => {
			record.history.push(...structuredClone(items));
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
		});
		return Promise.resolve();
	}
}

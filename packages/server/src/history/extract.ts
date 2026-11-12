import { isControlMessage, isTranscriptMessageRole } from "@thinkrail/contracts";
import { z } from "zod";

export interface HistoryEntry {
	text: string;
	role: "user" | "assistant";
	timestamp: number;
	messageIndex: number;
	entryId: string;
}

export interface ExtractedSession {
	id: string;
	cwd: string;
	title?: string;
	entries: HistoryEntry[];
}

const searchableRecord = z.object({
	version: z.literal(1),
	sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
	cwd: z.string().min(1),
	title: z.string().optional(),
	messages: z.array(
		z.object({
			id: z.string().min(1),
			role: z.string(),
			timestamp: z.number().finite(),
			content: z.unknown().optional(),
		}),
	),
});

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

export function extractSession(json: string): ExtractedSession | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	const parsed = searchableRecord.safeParse(value);
	if (!parsed.success) return null;
	const record = parsed.data;
	if (new Set(record.messages.map((message) => message.id)).size !== record.messages.length)
		return null;
	const messages = record.messages.filter((message) => isTranscriptMessageRole(message.role));
	const entries: HistoryEntry[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message.content);
		if (!text.trim() || (message.role === "user" && isControlMessage(text))) continue;
		entries.push({
			text,
			role: message.role,
			timestamp: message.timestamp,
			messageIndex,
			entryId: message.id,
		});
	}
	const title = record.title?.trim();
	return { id: record.sessionId, cwd: record.cwd, ...(title ? { title } : {}), entries };
}

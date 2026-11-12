import type { ToolCall, TranscriptMessage, WireCompactionSummary } from "@thinkrail/contracts";

/** Transcript evidence helpers, independent of any runtime journal or compaction driver. */
export function toolCalls(message: TranscriptMessage): ToolCall[] {
	return message.role === "assistant"
		? message.content.filter((part): part is ToolCall => part.type === "toolCall")
		: [];
}
function texts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) =>
		part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
	);
}
export function assistantText(message: TranscriptMessage): string {
	return message.role === "assistant" ? texts(message.content).join("") : "";
}
/** Counts explicit expansions and file-read attempts; it is not evidence that a model followed a Skill. */
export function isSkillLoad(message: TranscriptMessage, skill: string): boolean {
	const block = `<skill name="${skill}"`;
	if (message.role === "user")
		return texts(message.content).some((text) => text.trimStart().startsWith(block));
	if (message.role === "custom") return texts(message.content).some((text) => text.includes(block));
	return toolCalls(message).some(
		(call) =>
			call.name === "read" &&
			typeof call.arguments.path === "string" &&
			call.arguments.path.replaceAll("\\", "/").endsWith(`/${skill}/SKILL.md`),
	);
}
export interface CompactionSplit {
	before: TranscriptMessage[];
	after: TranscriptMessage[];
	compaction: WireCompactionSummary;
}
/** The committed retained cut belongs to the compaction transaction, not this visible summary. */
export function splitAtCompaction(messages: readonly TranscriptMessage[]): CompactionSplit {
	const index = messages.findLastIndex((message) => message.role === "compactionSummary");
	const compaction = messages[index];
	if (compaction?.role !== "compactionSummary")
		throw new Error("The transcript recorded no compaction summary");
	return { before: messages.slice(0, index), after: messages.slice(index + 1), compaction };
}

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface ToolResult<T = unknown> {
	content: { type: "text"; text: string }[];
	details: T;
	isError?: boolean;
}

export function truncateHead(text: string, options: { maxLines?: number; maxBytes?: number } = {}) {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const lines = text.length === 0 ? [] : text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	const totalBytes = Buffer.byteLength(text);
	const result = {
		content: text,
		truncated: false,
		truncatedBy: null as "bytes" | "lines" | null,
		totalLines: lines.length,
		totalBytes,
		outputLines: lines.length,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
	if (lines.length <= maxLines && totalBytes <= maxBytes) return result;
	const output: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (const line of lines.slice(0, maxLines)) {
		const bytes = Buffer.byteLength(line) + (output.length > 0 ? 1 : 0);
		if (outputBytes + bytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		output.push(line);
		outputBytes += bytes;
	}
	return {
		...result,
		content: output.join("\n"),
		truncated: true,
		truncatedBy,
		outputLines: output.length,
		outputBytes,
		firstLineExceedsLimit: Buffer.byteLength(lines[0] ?? "") > maxBytes,
	};
}

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WebAccessStatus } from "@thinkrail/contracts";
import { z } from "zod";
import { dataDir } from "../persistence";

const API_ROOT = "https://api.deepseek.com";
const RESPONSE_BYTES = 1024 * 1024;
const CONTENT_BYTES = 32 * 1024;
const keySchema = z.object({ apiKey: z.string().trim().min(1).max(4096) });
const resultSchema = z.object({
	title: z.string(),
	url: z.string().url().max(8192),
	summary: z.string().optional(),
	snippet: z.string().optional(),
});
const searchSchema = z.object({ results: z.array(resultSchema) });
const pageSchema = z.object({ title: z.string(), content: z.string() });

function configPath(): string {
	return join(dataDir(), "web-access.json");
}

function readKey(): string | undefined {
	let fd: number;
	try {
		fd = openSync(configPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("DeepSeek key configuration is unreadable");
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size > 8192 ||
			(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
		)
			throw new Error("Unsafe DeepSeek key configuration");
		return keySchema.parse(JSON.parse(readFileSync(fd, "utf8"))).apiKey;
	} catch {
		throw new Error("DeepSeek key configuration is unreadable");
	} finally {
		closeSync(fd);
	}
}

export function getWebAccessStatus(): WebAccessStatus {
	return { configured: readKey() !== undefined };
}

export function setWebAccessKey(apiKey: string): WebAccessStatus {
	const key = z.string().trim().max(4096).parse(apiKey);
	if (!key) {
		rmSync(configPath(), { force: true });
		return { configured: false };
	}
	mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
	const temporary = join(dataDir(), `.web-access.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ apiKey: key })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, configPath());
	} finally {
		rmSync(temporary, { force: true });
	}
	return { configured: true };
}

function boundedText(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

async function request(
	route: "search" | "fetch",
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	signal?.throwIfAborted();
	const key = readKey();
	if (!key)
		throw new Error("Configure a DeepSeek platform key in Settings to use web search and fetch");
	const activeSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
		: AbortSignal.timeout(30_000);
	const response = await fetch(`${API_ROOT}/v1/tools/${route}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: activeSignal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 401)
			throw new Error("DeepSeek rejected the platform key. Update it in Settings");
		if (response.status === 402)
			throw new Error("The DeepSeek platform account has insufficient balance");
		throw new Error(`DeepSeek ${route} failed (HTTP ${response.status})`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("DeepSeek returned an empty response");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	const abort = () => {
		void reader.cancel(activeSignal.reason).catch(() => {});
	};
	activeSignal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			activeSignal.throwIfAborted();
			const chunk = await reader.read();
			activeSignal.throwIfAborted();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > RESPONSE_BYTES) throw new Error("DeepSeek response exceeded the size limit");
			chunks.push(chunk.value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("DeepSeek returned invalid JSON");
		}
	} finally {
		activeSignal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export async function webSearch(query: string, count = 5, signal?: AbortSignal) {
	const normalized = z.string().trim().min(1).parse(query);
	if ([...normalized].length > 128)
		throw new Error("Use a search query with at most 128 characters");
	const limit = z.number().int().min(1).max(10).parse(count);
	const parsed = searchSchema.safeParse(
		await request("search", { query: normalized, count: limit, need_content: false }, signal),
	);
	if (!parsed.success) throw new Error("DeepSeek returned invalid search results");
	const results = parsed.data.results.slice(0, limit).map((result) => ({
		title: boundedText(result.title, 512),
		url: result.url,
		summary: boundedText(result.summary ?? result.snippet ?? "", 2048),
	}));
	const text = results.length
		? results.map((result) => `${result.title}\n${result.url}\n${result.summary}`).join("\n\n")
		: "No web results found.";
	signal?.throwIfAborted();
	return {
		content: [{ type: "text", text: boundedText(text, CONTENT_BYTES) }],
		details: { provider: "DeepSeek", results },
	};
}

export async function webFetch(url: string, signal?: AbortSignal) {
	if ([...url].length > 8192) throw new Error("Use a URL with at most 8192 characters");
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new Error("Use a valid HTTP or HTTPS URL");
	}
	if (
		!["http:", "https:"].includes(target.protocol) ||
		!target.hostname ||
		target.username ||
		target.password ||
		target.href.length > 8192
	)
		throw new Error("Use an HTTP or HTTPS URL with a host and no username or password");
	const parsed = pageSchema.safeParse(await request("fetch", { url: target.href }, signal));
	if (!parsed.success) throw new Error("DeepSeek returned invalid page content");
	const complete = `# ${boundedText(parsed.data.title, 512)}\n\n${parsed.data.content}`;
	const text = boundedText(complete, CONTENT_BYTES);
	signal?.throwIfAborted();
	return {
		content: [{ type: "text", text }],
		details: {
			provider: "DeepSeek",
			url: target.href,
			title: boundedText(parsed.data.title, 512),
			truncated: Buffer.byteLength(complete) > CONTENT_BYTES,
		},
	};
}

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWebAccessStatus, setWebAccessKey, webFetch, webSearch } from "./webAccess";

let directory: string;
let previous: string | undefined;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
beforeEach(() => {
	previous = process.env.THINKRAIL_DATA_DIR;
	directory = mkdtempSync(join(tmpdir(), "raildesign-web-access-"));
	process.env.THINKRAIL_DATA_DIR = directory;
});
afterEach(() => {
	fetchMock?.mockRestore();
	fetchMock = undefined;
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
	rmSync(directory, { recursive: true, force: true });
});

function offlineFetch(reply: (request: Request) => Response | Promise<Response>) {
	const implementation = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => reply(new Request(input, init));
	fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: () => {} }),
	);
	return fetchMock;
}

const key = "fixture-platform-key";
const page = () => Response.json({ title: "Page", content: "Page content" });

test("web access stores its separate key privately and exposes only configured status", () => {
	expect(getWebAccessStatus()).toEqual({ configured: false });
	expect(setWebAccessKey(key)).toEqual({ configured: true });
	expect(getWebAccessStatus()).toEqual({ configured: true });
	expect(JSON.stringify(getWebAccessStatus())).not.toContain(key);
	expect(readFileSync(join(directory, "web-access.json"), "utf8")).toContain(key);
	if (process.platform !== "win32")
		expect(statSync(join(directory, "web-access.json")).mode & 0o777).toBe(0o600);
	expect(setWebAccessKey("")).toEqual({ configured: false });
	expect(getWebAccessStatus()).toEqual({ configured: false });
});

test("web access rejects symbolic-link key files", () => {
	const target = join(directory, "outside.json");
	writeFileSync(target, JSON.stringify({ apiKey: key }), { mode: 0o600 });
	symlinkSync(target, join(directory, "web-access.json"));
	expect(() => getWebAccessStatus()).toThrow("unreadable");
});

test("missing keys and invalid inputs cannot start network requests", async () => {
	const fetch = offlineFetch(page);
	await expect(webSearch("test")).rejects.toThrow("Configure a DeepSeek platform key");
	setWebAccessKey(key);
	for (const query of ["", " ", "字".repeat(129)]) await expect(webSearch(query)).rejects.toThrow();
	await expect(webSearch("test", 11)).rejects.toThrow();
	for (const url of [
		"not-a-url",
		"file:///etc/passwd",
		"https://user:password@example.com",
		`https://example.com/${"a".repeat(8192)}`,
	])
		await expect(webFetch(url)).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

test("search uses only the DeepSeek endpoint and bounds returned results and text", async () => {
	setWebAccessKey(key);
	const requests: Request[] = [];
	offlineFetch((request) => {
		requests.push(request);
		return Response.json({
			results: Array.from({ length: 12 }, (_, i) => ({
				title: `Result ${i}`,
				url: `https://example.com/${i}`,
				summary: "字".repeat(3000),
			})),
		});
	});
	const result = await webSearch("字".repeat(128), 2);
	expect(requests).toHaveLength(1);
	const request = requests[0];
	if (!request) throw new Error("Missing request");
	expect(request.url).toBe("https://api.deepseek.com/v1/tools/search");
	expect(request.method).toBe("POST");
	expect(request.redirect).toBe("error");
	expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
	expect(await request.json()).toEqual({ query: "字".repeat(128), count: 2, need_content: false });
	expect(result.details.results).toHaveLength(2);
	expect(result.details.provider).toBe("DeepSeek");
	expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(32 * 1024);
	expect(result.details.results[0]?.summary).not.toContain("\uFFFD");
	expect(JSON.stringify(result)).not.toContain(key);
});

test("fetch returns bounded Markdown through the existing renderer contract", async () => {
	setWebAccessKey(key);
	let called: Request | undefined;
	offlineFetch((request) => {
		called = request;
		return Response.json({ title: "Title", content: "🧪".repeat(20_000) });
	});
	const result = await webFetch("https://example.com/article");
	expect(called?.url).toBe("https://api.deepseek.com/v1/tools/fetch");
	expect(await called?.json()).toEqual({ url: "https://example.com/article" });
	expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(32 * 1024);
	expect(result.content[0]?.text).not.toContain("\uFFFD");
	expect(result.details).toMatchObject({
		provider: "DeepSeek",
		truncated: true,
		url: "https://example.com/article",
	});
});

test("provider errors do not copy response bodies or keys into diagnostics", async () => {
	setWebAccessKey(key);
	for (const [status, message] of [
		[401, "rejected"],
		[402, "insufficient balance"],
		[429, "HTTP 429"],
	] as const) {
		fetchMock?.mockRestore();
		offlineFetch(() => new Response(`private error ${key}`, { status }));
		await expect(webSearch("query")).rejects.toThrow(message);
		try {
			await webFetch("https://example.com");
		} catch (error) {
			expect(String(error)).not.toContain(key);
		}
	}
});

test("malformed and oversized responses fail explicitly and cancel response reads", async () => {
	setWebAccessKey(key);
	offlineFetch(() => new Response("not JSON"));
	await expect(webSearch("query")).rejects.toThrow("invalid JSON");
	fetchMock?.mockRestore();
	offlineFetch(() => Response.json({ results: [{ title: "Missing URL" }] }));
	await expect(webSearch("query")).rejects.toThrow("invalid search results");
	fetchMock?.mockRestore();
	let cancelled = false;
	offlineFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024 + 1));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	await expect(webFetch("https://example.com")).rejects.toThrow("size limit");
	expect(cancelled).toBe(true);
});

test("Stop cancels a pending response read and prevents a result", async () => {
	setWebAccessKey(key);
	let cancelled = false;
	const controller = new AbortController();
	offlineFetch(
		() =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const pending = webFetch("https://example.com", controller.signal);
	await Bun.sleep(1);
	controller.abort(new Error("Stopped"));
	await expect(pending).rejects.toThrow("Stopped");
	expect(cancelled).toBe(true);
});

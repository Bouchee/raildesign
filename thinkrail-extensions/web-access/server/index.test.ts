import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import type { SdkToolServices } from "@thinkrail/extension-api/server";
import extension from "./index";

function fixture() {
	const calls: unknown[][] = [];
	const failures: string[] = [];
	let active = true;
	const services: SdkToolServices = {
		cwd: "/workspace",
		assertActive() {
			if (!active) throw new Error("Run revoked");
		},
		toolResponse: () => ({ kind: "deferred" }),
		markToolFailed: (callId) => {
			failures.push(callId);
		},
		setting: () => false,
		workspaceFiles: { check: async () => {}, scratchDir: "" },
		webAccess: {
			async search(...args) {
				calls.push(["search", ...args]);
				return {
					content: [{ type: "text", text: "Search result" }],
					details: { provider: "DeepSeek" },
				};
			},
			async fetch(...args) {
				calls.push(["fetch", ...args]);
				return { content: [{ type: "text", text: "Page" }], details: { provider: "DeepSeek" } };
			},
		},
	};
	return {
		services,
		calls,
		failures,
		revoke: () => {
			active = false;
		},
	};
}

test("web-access exposes the same SDK Search and Fetch tools to approved parents and children", () => {
	const { services } = fixture();
	expect(extension.sdkTools(services).map((tool) => tool.name)).toEqual([
		"web_search",
		"web_fetch",
	]);
	expect(extension.sdkChildTools(services).map((tool) => tool.name)).toEqual([
		"web_search",
		"web_fetch",
	]);
	expect(extension).not.toHaveProperty("extensions");
	expect(extension).not.toHaveProperty("skillPackages");
});

test("SDK web tools call only their supplied host service and preserve cancellation", async () => {
	const host = fixture();
	const [search, fetch] = extension.sdkTools(host.services);
	if (!search || !fetch) throw new Error("Missing web tools");
	const signal = new AbortController().signal;
	await search.invoke(new RunContext({}), JSON.stringify({ query: "SDK", count: null }), {
		signal,
	});
	await fetch.invoke(new RunContext({}), JSON.stringify({ url: "https://example.com" }), {
		signal,
	});
	expect(host.calls).toEqual([
		["search", "SDK", 5, signal],
		["fetch", "https://example.com", signal],
	]);
});

test("a revoked web tool cannot start the host request", async () => {
	const host = fixture();
	const tool = extension.sdkTools(host.services)[0];
	if (!tool) throw new Error("Missing search tool");
	host.revoke();
	const output = await tool.invoke(new RunContext({}), JSON.stringify({ query: "SDK", count: 1 }), {
		toolCall: { type: "function_call", callId: "web-call", name: "web_search", arguments: "{}" },
	});
	expect(JSON.parse(String(output))).toMatchObject({ isError: true, error: "Run revoked" });
	expect(host.calls).toEqual([]);
	expect(host.failures).toEqual(["web-call"]);
});

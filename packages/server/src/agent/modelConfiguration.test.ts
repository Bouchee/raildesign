import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Runner } from "@openai/agents";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import type { CustomEndpointDraft } from "@thinkrail/contracts";
import {
	configureAgentModelFactory,
	createConfiguredModel,
	listAvailableModels,
	listCustomEndpoints,
	modelOutputBudget,
	modelsPath,
	probeCustomEndpoint,
	resolveProviderAuthorization,
	responsesClientSettings,
	saveCustomEndpoint,
} from "./modelConfiguration";
import { completeOnce } from "./oneshot";

const keys = ["THINKRAIL_DATA_DIR", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_API_KEY"] as const;
let environment: (string | undefined)[];
let directory: string;
beforeEach(() => {
	environment = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	directory = mkdtempSync(join(tmpdir(), "raildesign-model-config-"));
	process.env.THINKRAIL_DATA_DIR = directory;
});
afterEach(() => {
	configureAgentModelFactory();
	keys.forEach((key, index) => {
		const value = environment[index];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	});
	rmSync(directory, { recursive: true, force: true });
});
function draft(): CustomEndpointDraft {
	return {
		name: "Verified Go",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		apiKey: "key-sentinel",
		models: [
			{
				id: "deepseek-v4.1-flash",
				contextWindow: 999999,
				maxTokens: 512,
				reasoning: true,
				vision: true,
				tools: false,
			},
		],
	};
}

function offlineFetch(reply: (request: Request) => Response): typeof fetch {
	const implementation = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => reply(new Request(input, init));
	return Object.assign(implementation, {
		preconnect: () => {
			throw new Error("Unexpected network preconnect in offline test");
		},
	});
}

test("saved capability knobs cannot advertise unverified context, reasoning or images", async () => {
	await saveCustomEndpoint(draft());
	const model = (await listAvailableModels())[0];
	if (!model) throw new Error("No verified model");
	expect(model).toMatchObject({
		id: "deepseek-v4.1-flash",
		contextWindow: 1_000_000,
		reasoning: false,
		thinkingLevels: ["off"],
		input: ["text"],
	});
	expect(model).not.toHaveProperty("cost");
	expect(modelOutputBudget(model)).toBe(512);
	expect((await listCustomEndpoints())[0]?.models[0]).toMatchObject({
		contextWindow: 1_000_000,
		reasoning: false,
		vision: false,
		tools: true,
	});
	expect(JSON.stringify(await listCustomEndpoints())).not.toContain("key-sentinel");
	if (process.platform !== "win32") expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
});

test("explicit MCP provider authorization uses owned credentials without exposing them in listings", async () => {
	const [saved] = await saveCustomEndpoint(draft());
	if (!saved) throw new Error("No endpoint");
	expect(resolveProviderAuthorization(saved.id)).toBe("Bearer key-sentinel");
	expect(() => resolveProviderAuthorization("unconfigured-provider")).toThrow("not configured");
	process.env.OPENAI_BASE_URL = "https://example.test/v1";
	process.env.OPENAI_MODEL = "test-model";
	process.env.OPENAI_API_KEY = "environment-key-sentinel";
	expect(resolveProviderAuthorization("environment")).toBe("Bearer environment-key-sentinel");
	expect(JSON.stringify(await listCustomEndpoints())).not.toContain("key-sentinel");
});

test("unverified endpoint or model cannot replace the working configuration", async () => {
	await saveCustomEndpoint(draft());
	const before = readFileSync(modelsPath(), "utf8");
	await expect(
		saveCustomEndpoint({ ...draft(), baseUrl: "https://example.invalid/v1" }),
	).rejects.toThrow("verified Go endpoint");
	const model = draft().models[0];
	if (!model) throw new Error("No model fixture");
	await expect(
		saveCustomEndpoint({ ...draft(), models: [{ ...model, id: "unverified-model" }] }),
	).rejects.toThrow("verified Go endpoint");
	expect(readFileSync(modelsPath(), "utf8")).toBe(before);
});

test("a missing key fails before network and updating an endpoint does not disclose its saved key", async () => {
	const saved = await saveCustomEndpoint(draft());
	const first = saved[0];
	if (!first) throw new Error("No endpoint");
	const update = { ...draft(), id: first.id };
	delete update.apiKey;
	await saveCustomEndpoint(update);
	expect(JSON.stringify(await listCustomEndpoints())).not.toContain("key-sentinel");
	await saveCustomEndpoint({ ...draft(), id: first.id, apiKey: "" });
	const model = (await listAvailableModels())[0];
	if (!model) throw new Error("No model");
	expect(() => createConfiguredModel(model, "missing-key-session")).toThrow("Configure an API key");
});

test("obsolete and corrupt configuration is rejected instead of read or imported", async () => {
	for (const content of [
		"broken-json",
		JSON.stringify({ providers: {} }),
		JSON.stringify({ version: 2, endpoints: [] }),
	]) {
		writeFileSync(join(directory, "models.json"), content);
		await expect(listAvailableModels()).rejects.toThrow(
			"RailDesign model configuration is unreadable",
		);
	}
});

test("environment configuration cannot offer an unverified model", async () => {
	process.env.OPENAI_BASE_URL = "https://example.invalid/v1";
	process.env.OPENAI_MODEL = "unverified-model";
	process.env.OPENAI_API_KEY = "key-sentinel";
	expect(await listAvailableModels()).toEqual([]);
});

test("one-shot assistance uses the same SDK model and fails explicitly without configuration", async () => {
	await expect(completeOnce({ prompt: "hi" })).rejects.toThrow("no-model");
	await saveCustomEndpoint(draft());
	const model = new ScriptedModel([modelResponse([assistantMessage("one-shot answer")])]);
	configureAgentModelFactory(() => model);
	const result = await completeOnce({ prompt: "hi", maxTokens: 64 });
	expect(result.text).toBe("one-shot answer");
	expect(result.model.id).toBe("deepseek-v4.1-flash");
	expect(model.firstCall?.request.modelSettings.maxTokens).toBe(64);
	model.assertComplete();
});

test("outbound SDK requests identify RailDesign and retain the application conversation independently of credentials", async () => {
	await saveCustomEndpoint(draft());
	const model = (await listAvailableModels())[0];
	if (!model) throw new Error("No model fixture");
	const requests: Request[] = [];
	const mockedFetch = spyOn(globalThis, "fetch").mockImplementation(
		offlineFetch((request) => {
			requests.push(request);
			return Response.json({
				id: `response-${requests.length}`,
				object: "response",
				created_at: 1,
				status: "completed",
				model: model.id,
				output: [
					{
						id: `message-${requests.length}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "header fixture", annotations: [] }],
					},
				],
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			});
		}),
	);
	try {
		for (const sessionId of ["conversation-a", "conversation-a", "conversation-b"]) {
			const agent = new Agent({
				name: "Header fixture",
				model: createConfiguredModel(model, sessionId),
				modelSettings: responsesClientSettings,
			});
			expect(
				(await new Runner({ tracingDisabled: true }).run(agent, "check headers")).finalOutput,
			).toBe("header fixture");
		}
		await completeOnce({ prompt: "first one-shot" });
		await completeOnce({ prompt: "second one-shot" });
		expect(requests).toHaveLength(5);
		expect(
			requests.slice(0, 3).map((request) => request.headers.get("x-opencode-session")),
		).toEqual(["conversation-a", "conversation-a", "conversation-b"]);
		const oneShotIds = requests
			.slice(3)
			.map((request) => request.headers.get("x-opencode-session"));
		expect(new Set(oneShotIds).size).toBe(2);
		for (const id of oneShotIds) expect(id).toMatch(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/);
		for (const request of requests) {
			expect(request.url).toBe("https://opencode.ai/inference/go/openai/v1/responses");
			expect(request.headers.get("User-Agent")).toBe("RailDesign/0.1");
			expect(request.headers.get("authorization")).toBe("Bearer key-sentinel");
			expect(request.headers.get("x-opencode-session")).not.toBe("key-sentinel");
		}
		expect(() => createConfiguredModel(model, "")).toThrow("application session ID is required");
		expect(requests).toHaveLength(5);
	} finally {
		mockedFetch.mockRestore();
	}
});

test("model discovery identifies RailDesign without inventing a model conversation", async () => {
	const requests: Request[] = [];
	const mockedFetch = spyOn(globalThis, "fetch").mockImplementation(
		offlineFetch((request) => {
			requests.push(request);
			return Response.json({ data: [{ id: "deepseek-v4.1-flash" }] });
		}),
	);
	try {
		const result = await probeCustomEndpoint({ baseUrl: draft().baseUrl, apiKey: "key-sentinel" });
		expect(result.ok).toBe(true);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request) throw new Error("No discovery request");
		expect(request.url).toBe("https://opencode.ai/inference/go/openai/v1/models");
		expect(request.headers.get("User-Agent")).toBe("RailDesign/0.1");
		expect(request.headers.get("x-opencode-session")).toBeNull();
	} finally {
		mockedFetch.mockRestore();
	}
});

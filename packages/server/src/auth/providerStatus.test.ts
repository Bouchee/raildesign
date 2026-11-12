import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCustomEndpoint } from "../agent";
import { getProviderStatus } from "./providerStatus";

const keys = [
	"THINKRAIL_DATA_DIR",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"OPENAI_API_KEY",
	"RAILDESIGN_TEST_KEY",
] as const;
let previous: (string | undefined)[];
let directory: string;
beforeEach(() => {
	previous = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	directory = mkdtempSync(join(tmpdir(), "raildesign-auth-"));
	process.env.THINKRAIL_DATA_DIR = directory;
});
afterEach(() => {
	keys.forEach((key, index) => {
		const value = previous[index];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	});
	rmSync(directory, { recursive: true, force: true });
});

test("reports only configured SDK endpoint identities without credentials", async () => {
	await saveCustomEndpoint({
		name: "Private endpoint",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		apiKey: "private-key-sentinel",
		models: [
			{
				id: "deepseek-v4.1-flash",
				contextWindow: 128000,
				maxTokens: 8192,
				reasoning: false,
				vision: false,
				tools: true,
			},
		],
	});
	const report = await getProviderStatus();
	expect(report.providers).toHaveLength(1);
	expect(report.providers[0]).toMatchObject({
		name: "Private endpoint",
		configured: true,
		kind: "api-key",
	});
	expect(JSON.stringify(report)).not.toContain("private-key-sentinel");
	expect(JSON.stringify(report)).not.toContain("opencode.ai");
	expect(report).not.toHaveProperty("jbcentral");
});

test("an unresolved key variable remains unconfigured", async () => {
	await saveCustomEndpoint({
		name: "Unset key",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		apiKey: "$RAILDESIGN_TEST_KEY",
		models: [
			{
				id: "deepseek-v4.1-flash",
				contextWindow: null,
				maxTokens: null,
				reasoning: null,
				vision: null,
				tools: null,
			},
		],
	});
	expect((await getProviderStatus()).providers[0]?.configured).toBe(false);
	process.env.RAILDESIGN_TEST_KEY = "protected-key";
	expect((await getProviderStatus()).providers[0]?.configured).toBe(true);
});

test("host environment configuration uses the same status path", async () => {
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "protected-key";
	expect((await getProviderStatus()).providers).toEqual([
		expect.objectContaining({ id: "environment", configured: true }),
	]);
});

test("malformed own configuration fails instead of reporting an empty provider list", async () => {
	writeFileSync(join(directory, "models.json"), "broken");
	await expect(getProviderStatus()).rejects.toThrow("RailDesign model configuration is unreadable");
});

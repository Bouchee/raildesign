import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DATA_DIR } from "./paths";
import type { E2eWire } from "./wire";

export const LIVE_AGENT_E2E_ENV = "RAILDESIGN_E2E_LIVE";
export const DEFAULT_E2E_MODEL = "custom-e2e/deepseek-v4.1-flash";
export interface E2eModelTarget {
	provider: string;
	id: string;
}
export class AgentSetupError extends Error {}

export function isLiveAgentE2e(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[LIVE_AGENT_E2E_ENV] === "1";
}

export function resolveE2eModel(env: NodeJS.ProcessEnv = process.env): E2eModelTarget {
	const value = env.THINKRAIL_E2E_MODEL ?? DEFAULT_E2E_MODEL;
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1)
		throw new Error("THINKRAIL_E2E_MODEL must use the exact provider/modelId form");
	return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function seedAgentConfiguration(
	dataDirectory = E2E_DATA_DIR,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const target = resolveE2eModel(env);
	if (target.id !== "deepseek-v4.1-flash")
		throw new AgentSetupError("The E2E target must be the verified Go model");
	mkdirSync(dataDirectory, { recursive: true });
	writeFileSync(
		join(dataDirectory, "models.json"),
		JSON.stringify({
			version: 1,
			endpoints: [
				{
					id: target.provider,
					name: "OpenCode Go",
					baseUrl: "https://opencode.ai/inference/go/openai/v1",
					apiKey: isLiveAgentE2e(env) ? "$RAILDESIGN_E2E_API_KEY" : "",
					models: [
						{
							id: target.id,
							contextWindow: null,
							maxTokens: null,
							reasoning: null,
							vision: null,
							tools: true,
						},
					],
				},
			],
		}),
		{ mode: 0o600 },
	);
}

export function isExactE2eModel(
	model: E2eModelTarget | null | undefined,
	target: E2eModelTarget,
): boolean {
	return model?.provider === target.provider && model.id === target.id;
}

export async function seedE2eDefaultModel(wire: Pick<E2eWire, "request">): Promise<void> {
	const target = resolveE2eModel();
	const models = await wire.request("model.list", {});
	const model = models.find((candidate) => isExactE2eModel(candidate, target));
	if (!model) throw new AgentSetupError("The configured E2E model is unavailable");
	await wire.request("settings.update", { config: { defaultModel: model, defaultEffort: "off" } });
}

export async function waitForAgentTarget(wire: Pick<E2eWire, "request">): Promise<void> {
	const target = resolveE2eModel();
	const status = await wire.request("provider.status", {});
	if (!status.providers.some((provider) => provider.id === target.provider && provider.configured))
		throw new AgentSetupError("The isolated SDK host has no configured live key");
	await seedE2eDefaultModel(wire);
	const selected = await wire.request("model.default", {});
	if (!isExactE2eModel(selected.model, target))
		throw new AgentSetupError("The isolated SDK host selected an unexpected model");
}

export function readLiveAgentKey(configPath: string): string {
	const mode = statSync(configPath).mode;
	if (process.platform !== "win32" && (mode & 0o077) !== 0)
		throw new Error("Live acceptance configuration must be readable only by its owner");
	const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (
		typeof config !== "object" ||
		config === null ||
		!("apiKey" in config) ||
		typeof config.apiKey !== "string" ||
		!config.apiKey ||
		!("baseURL" in config) ||
		config.baseURL !== "https://opencode.ai/inference/go/openai/v1" ||
		!("model" in config) ||
		config.model !== "deepseek-v4.1-flash"
	)
		throw new Error("Live acceptance configuration must select the verified Go/DeepSeek target");
	return config.apiKey;
}

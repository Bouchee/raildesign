import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModel, type ScriptedModelInput } from "@openai/agents/testing";
import type { WireModel } from "@thinkrail/contracts";
import { configureAgentModelFactory } from "../agent";

export function seedSdkTestModel(directory: string, provider: string): WireModel {
	const id = "deepseek-v4.1-flash";
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "models.json"),
		JSON.stringify({
			version: 1,
			endpoints: [
				{
					id: provider,
					name: provider,
					baseUrl: "https://opencode.ai/inference/go/openai/v1",
					apiKey: "",
					models: [
						{
							id,
							contextWindow: null,
							maxTokens: null,
							reasoning: false,
							vision: false,
							tools: true,
						},
					],
				},
			],
		}),
		{ mode: 0o600 },
	);
	return {
		provider,
		id,
		name: id,
		contextWindow: 0,
		reasoning: false,
		thinkingLevels: ["off"],
		input: ["text"],
		auth: { kind: "api-key" },
	};
}

export function useSdkTestModel(steps: Iterable<ScriptedModelInput>): ScriptedModel {
	const model = new ScriptedModel(steps);
	configureAgentModelFactory(() => model);
	return model;
}

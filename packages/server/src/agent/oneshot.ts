import { randomUUID } from "node:crypto";
import { Agent, Runner } from "@openai/agents";
import type { WireModel } from "@thinkrail/contracts";
import {
	createConfiguredModel,
	listAvailableModels,
	responsesClientSettings,
} from "./modelConfiguration";
export type ModelTier = "cheap" | "default";
export interface OneShotRequest {
	system?: string;
	prompt: string;
	tier?: ModelTier;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}
export interface OneShotResult {
	text: string;
	model: { provider: string; id: string };
}
export async function pickModel(): Promise<WireModel | null> {
	return (await listAvailableModels())[0] ?? null;
}
export async function completeOnce(request: OneShotRequest): Promise<OneShotResult> {
	const model = await pickModel();
	if (!model) throw new Error("no-model");
	const agent = new Agent({
		name: "RailDesign assistant",
		...(request.system ? { instructions: request.system } : {}),
		model: createConfiguredModel(model, randomUUID()),
		modelSettings: {
			...responsesClientSettings,
			maxTokens: request.maxTokens ?? 256,
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
		},
	});
	const result = await new Runner({ tracingDisabled: true }).run(agent, request.prompt, {
		maxTurns: 1,
		...(request.signal ? { signal: request.signal } : {}),
	});
	return {
		text: result.finalOutput?.trim() ?? "",
		model: { provider: model.provider, id: model.id },
	};
}

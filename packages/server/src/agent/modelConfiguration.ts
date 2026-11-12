import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Model, OpenAIResponsesModel } from "@openai/agents";
import type {
	CustomEndpoint,
	CustomEndpointDraft,
	CustomEndpointProbe,
	CustomEndpointProbeRequest,
	ProviderStatus,
	RefreshedModels,
	ThinkingLevel,
	WireModel,
} from "@thinkrail/contracts";
import { CUSTOM_ENDPOINT_ID_PREFIX } from "@thinkrail/contracts";
import OpenAI from "openai";
import { z } from "zod";
import { dataDir } from "../persistence";

const modelSchema = z.object({
	id: z.string().trim().min(1),
	contextWindow: z.number().int().positive().nullable(),
	maxTokens: z.number().int().positive().nullable(),
	reasoning: z.boolean().nullable(),
	vision: z.boolean().nullable(),
	tools: z.boolean().nullable(),
});
const endpointSchema = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1),
	baseUrl: z.string().url(),
	apiKey: z.string(),
	models: z.array(modelSchema).min(1).max(500),
});
const configSchema = z.object({ version: z.literal(1), endpoints: z.array(endpointSchema) });
type Endpoint = z.infer<typeof endpointSchema>;
const VERIFIED_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const VERIFIED_MODEL = "deepseek-v4.1-flash";
const CLIENT_USER_AGENT = "RailDesign/0.1";
export const responsesClientSettings = {
	providerData: { extra_headers: { "User-Agent": CLIENT_USER_AGENT } },
};

let publishModels: (() => void) | null = null;
let publishListings: (() => void) | null = null;
let modelFactory: ((model: WireModel, sessionId: string) => Model) | undefined;

export function setModelsFilePublisher(fn: (() => void) | null): void {
	publishModels = fn;
}
export function setModelListingPublisher(fn: (() => void) | null): void {
	publishListings = fn;
}
export function configureAgentModelFactory(
	factory?: (model: WireModel, sessionId: string) => Model,
): void {
	modelFactory = factory;
}
export function modelsPath(): string {
	return join(dataDir(), "models.json");
}

function readConfig(): { version: 1; endpoints: Endpoint[] } {
	try {
		return configSchema.parse(JSON.parse(readFileSync(modelsPath(), "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { version: 1, endpoints: [] };
		throw new Error("RailDesign model configuration is unreadable", { cause: error });
	}
}

function commit(endpoints: Endpoint[]): void {
	const config = configSchema.parse({ version: 1, endpoints });
	mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
	const temporary = join(dataDir(), `.models.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
		renameSync(temporary, modelsPath());
	} finally {
		rmSync(temporary, { force: true });
	}
	publishModels?.();
	publishListings?.();
}

export function parseBaseUrl(raw: string): string | null {
	try {
		const url = new URL(raw.trim());
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return null;
		url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(responses|models)$/, "");
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function keyEnvironmentName(raw: string): string | undefined {
	const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(raw);
	return match?.[1] ?? match?.[2];
}

function keyOf(raw: string): string {
	const name = keyEnvironmentName(raw);
	const value = name ? process.env[name] : raw;
	if (!value) throw new Error("Configure an API key for the selected endpoint");
	return value;
}

export function modelKeyEnvironmentNames(): string[] {
	return endpoints().flatMap((endpoint) => {
		const name = keyEnvironmentName(endpoint.apiKey);
		return name ? [name] : [];
	});
}

export function resolveProviderAuthorization(provider: string): string {
	const endpoint = endpoints().find((candidate) => candidate.id === provider);
	if (!endpoint) throw new Error("MCP authorization provider is not configured");
	return `Bearer ${keyOf(endpoint.apiKey)}`;
}

function endpoints(): Endpoint[] {
	const configured = readConfig().endpoints;
	const baseUrl = process.env.OPENAI_BASE_URL;
	const id = process.env.OPENAI_MODEL;
	if (baseUrl && id && process.env.OPENAI_API_KEY) {
		const parsed = parseBaseUrl(baseUrl);
		if (!parsed) throw new Error("OPENAI_BASE_URL must be a valid Responses base URL");
		configured.push({
			id: "environment",
			name: "Configured Responses endpoint",
			baseUrl: parsed,
			apiKey: "$OPENAI_API_KEY",
			models: [
				{ id, contextWindow: 0, maxTokens: 8192, reasoning: false, vision: false, tools: true },
			],
		});
	}
	return configured;
}

function wireModel(endpoint: Endpoint, model: Endpoint["models"][number]): WireModel {
	return {
		id: model.id,
		name: model.id,
		provider: endpoint.id,
		contextWindow: 0,
		reasoning: false,
		thinkingLevels: ["off"],
		input: ["text"],
		auth: { kind: "api-key" },
	};
}

function verified(endpoint: Endpoint, model: Endpoint["models"][number]): boolean {
	return endpoint.baseUrl === VERIFIED_BASE_URL && model.id === VERIFIED_MODEL;
}
export function configuredProviderStatuses(): ProviderStatus[] {
	return endpoints().map((endpoint) => {
		let configured = false;
		try {
			configured = keyOf(endpoint.apiKey).length > 0;
		} catch {}
		return {
			id: endpoint.id,
			name: endpoint.name,
			configured,
			...(configured ? { kind: "api-key" as const } : {}),
		};
	});
}
export async function listAvailableModels(): Promise<WireModel[]> {
	return endpoints().flatMap((endpoint) =>
		endpoint.models
			.filter((model) => verified(endpoint, model))
			.map((model) => wireModel(endpoint, model)),
	);
}
export const listSettledModels = listAvailableModels;
export async function refreshAvailableModels(): Promise<RefreshedModels> {
	return { models: await listAvailableModels(), complete: true };
}
export function preferredDefaultModel(models: readonly WireModel[]): WireModel | undefined {
	return models[0];
}
export function defaultModelRef(): { provider: string; id: string } | undefined {
	const endpoint = endpoints()[0];
	const model = endpoint?.models[0];
	return endpoint && model ? { provider: endpoint.id, id: model.id } : undefined;
}
export async function clampThinkingForModel(
	model: Pick<WireModel, "provider" | "id">,
	level: ThinkingLevel,
): Promise<ThinkingLevel> {
	const configured = (await listAvailableModels()).find(
		(item) => item.provider === model.provider && item.id === model.id,
	);
	if (!configured) throw new Error("Unknown model");
	return configured.thinkingLevels.includes(level) ? level : "off";
}

export function createConfiguredModel(model: WireModel, sessionId: string): Model {
	if (typeof sessionId !== "string" || !sessionId.trim())
		throw new Error("An application session ID is required");
	if (modelFactory) return modelFactory(model, sessionId);
	const endpoint = endpoints().find(
		(item) =>
			item.id === model.provider && item.models.some((candidate) => candidate.id === model.id),
	);
	if (
		!endpoint?.models.some(
			(candidate) => candidate.id === model.id && verified(endpoint, candidate),
		)
	)
		throw new Error("This endpoint/model has not passed the Responses/tool gate");
	return new OpenAIResponsesModel(
		new OpenAI({
			apiKey: keyOf(endpoint.apiKey),
			baseURL: endpoint.baseUrl,
			maxRetries: 0,
			defaultHeaders: { "User-Agent": CLIENT_USER_AGENT, "x-opencode-session": sessionId },
		}),
		model.id,
	);
}

export function modelOutputBudget(model: Pick<WireModel, "provider" | "id">): number {
	const configured = endpoints()
		.find((endpoint) => endpoint.id === model.provider)
		?.models.find((candidate) => candidate.id === model.id);
	return Math.min(configured?.maxTokens ?? 8192, 8192);
}

export async function listCustomEndpoints(): Promise<CustomEndpoint[]> {
	return readConfig().endpoints.map(({ apiKey, ...endpoint }) => ({
		...endpoint,
		hasApiKey: apiKey.length > 0,
	}));
}

export async function saveCustomEndpoint(draft: CustomEndpointDraft): Promise<CustomEndpoint[]> {
	const config = readConfig();
	const previous = draft.id
		? config.endpoints.find((endpoint) => endpoint.id === draft.id)
		: undefined;
	if (draft.id && !previous) throw new Error("Unknown endpoint");
	const baseUrl = parseBaseUrl(draft.baseUrl);
	if (!baseUrl) throw new Error("Invalid Responses base URL");
	if (baseUrl !== VERIFIED_BASE_URL || draft.models.some((model) => model.id !== VERIFIED_MODEL))
		throw new Error("Stage 1 supports the verified Go endpoint and deepseek-v4.1-flash model");
	const next = endpointSchema.parse({
		...draft,
		models: draft.models.map((model) => ({
			...model,
			contextWindow: null,
			reasoning: false,
			vision: false,
			tools: true,
		})),
		id: previous?.id ?? `${CUSTOM_ENDPOINT_ID_PREFIX}${randomUUID()}`,
		baseUrl,
		apiKey: draft.apiKey ?? previous?.apiKey ?? "",
	});
	if (new Set(next.models.map((model) => model.id)).size !== next.models.length)
		throw new Error("Model IDs must be unique");
	commit([...config.endpoints.filter((endpoint) => endpoint.id !== next.id), next]);
	return listCustomEndpoints();
}

export async function removeCustomEndpoint(id: string): Promise<CustomEndpoint[]> {
	commit(readConfig().endpoints.filter((endpoint) => endpoint.id !== id));
	return listCustomEndpoints();
}

export async function probeCustomEndpoint(
	request: CustomEndpointProbeRequest,
): Promise<CustomEndpointProbe> {
	const baseUrl = parseBaseUrl(request.baseUrl);
	if (!baseUrl) return { ok: false, reason: "invalid-url" };
	if (baseUrl !== VERIFIED_BASE_URL) return { ok: false, reason: "not-openai" };
	const previous = request.endpointId
		? readConfig().endpoints.find(
				(endpoint) => endpoint.id === request.endpointId && endpoint.baseUrl === baseUrl,
			)
		: undefined;
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/models`, {
			headers: {
				authorization: `Bearer ${keyOf(request.apiKey ?? previous?.apiKey ?? "")}`,
				"User-Agent": CLIENT_USER_AGENT,
			},
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	if (response.status === 401 || response.status === 403)
		return { ok: false, reason: "unauthorized", status: response.status };
	if (!response.ok) return { ok: false, reason: "not-openai", status: response.status };
	const parsed = z
		.object({ data: z.array(z.object({ id: z.string().min(1) })) })
		.safeParse(await response.json().catch(() => null));
	if (!parsed.success) return { ok: false, reason: "not-openai" };
	const models = [...new Set(parsed.data.data.map((model) => model.id))]
		.filter((id) => id === VERIFIED_MODEL)
		.map((id) => ({
			id,
			contextWindow: null,
			maxTokens: null,
			reasoning: null,
			vision: null,
			tools: null,
		}));
	return models.length ? { ok: true, baseUrl, models } : { ok: false, reason: "no-models" };
}

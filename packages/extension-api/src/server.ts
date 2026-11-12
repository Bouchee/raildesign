import type { Tool } from "@openai/agents";

export type ToolResponse =
	| { kind: "response"; value: unknown }
	| { kind: "deferred" }
	| { kind: "abandoned" };

export interface WorkspaceFiles {
	check(path: string, cwd: string): Promise<void>;
	scratchDir: string;
}

export interface ExtensionBooleanSetting {
	type: "boolean";
	default: boolean;
}

export type ExtensionSetting = ExtensionBooleanSetting;

export interface WebAccessServices {
	search(query: string, count: number, signal?: AbortSignal): Promise<unknown>;
	fetch(url: string, signal?: AbortSignal): Promise<unknown>;
}

export interface SdkToolServices {
	webAccess: WebAccessServices;
	cwd: string;
	assertActive(): void;
	toolResponse(toolCallId: string): ToolResponse;
	setting(key: string): boolean;
	workspaceFiles: WorkspaceFiles;
}

export interface InteractiveTool {
	validateArgs?: (args: unknown) => void;
	parseResponse?: (args: unknown, response: unknown) => unknown;
	describeResponse?: (args: unknown, response: unknown) => string | undefined;
}

export interface ServerExtension {
	name: string;
	title?: string;
	description?: string;
	interactiveTools?: Record<string, InteractiveTool>;
	sdkTools?: (session: SdkToolServices) => Tool[];
	settings?: Record<string, ExtensionSetting>;
	sdkChildTools?: (session: SdkToolServices) => Tool[];
	skillPackages?: string[];
}

export function defineServerExtension<T extends ServerExtension>(extension: T): T {
	return extension;
}

export { type ParsedToolResultContent, parseToolResultContent } from "./toolResultContent";

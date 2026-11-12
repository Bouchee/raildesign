import type { McpExposure } from "@thinkrail/contracts";

export type { McpExposure } from "@thinkrail/contracts";
export const CONFIG_DIR_NAME = ".raildesign";

export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "auto" | "dcr" | "cimd";
	clientMetadataUrl?: string;
	authServerMetadataUrl?: string;
}

interface McpServerConfigBase {
	enabled?: boolean;
	description?: string;
	timeout?: number;
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http" | "streamable-http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	auth?: { provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	source: string;
	scope?: "global" | "project" | "extension";
	override?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	autoEnableCodemode?: boolean;
	errors: string[];
	projectConfig?: string;
}

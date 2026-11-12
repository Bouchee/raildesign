import type {
	HostEnvironment,
	HostEnvironmentIssue,
	HostEnvironmentStatus,
	HostEnvironmentUpdateResult,
} from "@thinkrail/contracts";
import { launchEnvKeys } from "@thinkrail/shared/shellEnv";
import { logger } from "../log";
import { loadHostEnvironment, saveHostEnvironment } from "../persistence";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(["PATH", "HOME", "USERPROFILE", "OPENAI_API_KEY"]);

const log = logger("environment");

let applied: HostEnvironment = { vars: [] };
let launchKeys: ReadonlySet<string> = new Set();
let platform: NodeJS.Platform = process.platform;

function nameKey(name: string): string {
	return platform === "win32" ? name.toUpperCase() : name;
}

function isReserved(name: string): boolean {
	return (
		RESERVED_NAMES.has(name.toUpperCase()) || /^(THINKRAIL_|RAILDESIGN_)/.test(name.toUpperCase())
	);
}

export function validateHostEnvironment(environment: HostEnvironment): HostEnvironmentIssue[] {
	const issues: HostEnvironmentIssue[] = [];
	const seen = new Set<string>();
	environment.vars.forEach(({ name }, index) => {
		if (!ENV_NAME.test(name)) issues.push({ field: "var", index, code: "invalidName" });
		else if (isReserved(name)) issues.push({ field: "var", index, code: "reserved" });
		else if (seen.has(nameKey(name))) issues.push({ field: "var", index, code: "duplicate" });
		seen.add(nameKey(name));
	});
	return issues;
}

function parseHostEnvironment(value: unknown): HostEnvironment | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (Object.keys(value).some((key) => key !== "vars")) return null;
	const { vars } = value as Record<string, unknown>;
	if (!Array.isArray(vars)) return null;
	const parsed: HostEnvironment["vars"] = [];
	for (const entry of vars) {
		if (typeof entry !== "object" || entry === null) return null;
		const { name, value: varValue } = entry as Record<string, unknown>;
		if (typeof name !== "string" || typeof varValue !== "string") return null;
		const trimmed = name.trim();
		if (trimmed.length === 0 && varValue.length === 0) continue;
		parsed.push({ name: trimmed, value: varValue });
	}
	return { vars: parsed };
}

function sameEnvironment(a: HostEnvironment, b: HostEnvironment): boolean {
	return (
		a.vars.length === b.vars.length &&
		a.vars.every((entry, i) => entry.name === b.vars[i]?.name && entry.value === b.vars[i]?.value)
	);
}

function launchOverridden(environment: HostEnvironment): string[] {
	const invalid = new Set(
		validateHostEnvironment(environment).flatMap((issue) =>
			issue.field === "var" ? [issue.index] : [],
		),
	);
	const names = [
		...environment.vars.filter((_, index) => !invalid.has(index)).map(({ name }) => name),
	];
	return names.filter((name) => launchKeys.has(nameKey(name)));
}

export function applyHostEnvironment(options: { platform?: NodeJS.Platform } = {}): void {
	platform = options.platform ?? process.platform;
	const stored = loadHostEnvironment();
	applied = stored;
	launchKeys = new Set([...launchEnvKeys()].map(nameKey));
	const issues = validateHostEnvironment(stored);
	const skippedVars = new Set(
		issues.flatMap((issue) => (issue.field === "var" ? [issue.index] : [])),
	);
	stored.vars.forEach(({ name, value }, index) => {
		if (!skippedVars.has(index) && !launchKeys.has(nameKey(name))) process.env[name] = value;
	});
	for (const issue of issues)
		log.warn(`stored environment entry skipped: ${issue.field}/${issue.code}`);
}

export function hostEnvironmentStatus(): HostEnvironmentStatus {
	const stored = loadHostEnvironment();
	return {
		stored,
		restartRequired: !sameEnvironment(stored, applied),
		launchOverridden: launchOverridden(stored),
	};
}

export function updateHostEnvironment(value: unknown): HostEnvironmentUpdateResult {
	const environment = parseHostEnvironment(value);
	if (!environment) throw new Error("Invalid environment record");
	const issues = validateHostEnvironment(environment);
	if (issues.length > 0) return { ok: false, issues };
	saveHostEnvironment(environment);
	return { ok: true, status: hostEnvironmentStatus() };
}

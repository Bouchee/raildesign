import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { applyDiff, tool } from "@openai/agents";
import { z } from "zod";
import { readFile, resolveWorktreeFile } from "../fs";
import { runBounded } from "../subprocess";
import { modelKeyEnvironmentNames } from "./modelConfiguration";

export interface ToolGrant {
	workspaceId: string;
	cwd: string;
	signal: AbortSignal;
	assertActive: () => void;
}

export function toolEnvironment(
	modelKeys: ReadonlySet<string>,
): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				!modelKeys.has(name.toUpperCase()) &&
				!/(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?|AUTHORIZATION)$/i.test(name),
		),
	);
}

function target(grant: ToolGrant, path: string): string {
	grant.assertActive();
	grant.signal.throwIfAborted();
	if (isAbsolute(path)) throw new Error("Use a path relative to the assigned worktree");
	return resolveWorktreeFile(grant.workspaceId, path);
}

export function applyWorkspacePatch(
	grant: ToolGrant,
	input: { path: string; diff: string; original: string | null },
): string {
	const path = target(grant, input.path);
	let previous: string | null = null;
	try {
		if (!statSync(path).isFile()) throw new Error("Patch target must be a file");
		previous = readFileSync(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (previous !== input.original) throw new Error("Original text changed; read the file again");
	const content = applyDiff(previous ?? "", input.diff, previous === null ? "create" : "default");
	mkdirSync(dirname(path), { recursive: true });
	target(grant, input.path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, {
			mode: previous === null ? 0o644 : statSync(path).mode & 0o777,
		});
		target(grant, input.path);
		if (previous !== null && readFileSync(path, "utf8") !== previous)
			throw new Error("Original text changed; read the file again");
		if (previous === null) {
			try {
				statSync(path);
				throw new Error("Patch target appeared; read the file again");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	return `Updated ${input.path}`;
}

export function workspaceTools(grant: ToolGrant) {
	const modelKeys = new Set(modelKeyEnvironmentNames().map((name) => name.toUpperCase()));
	return [
		tool({
			errorFunction: null,
			name: "read",
			description:
				"Read a UTF-8 file in the assigned worktree. Read the original content before editing.",
			parameters: z.object({ path: z.string().min(1) }),
			execute({ path }) {
				target(grant, path);
				const result = readFile(grant.workspaceId, path, { maxBytes: 262144 });
				if (!result.meta.text) throw new Error("File is not text");
				return result.content;
			},
		}),
		tool({
			errorFunction: null,
			name: "search",
			description:
				"Search tracked and untracked worktree files with a literal text query. Git metadata and ignored files are excluded.",
			parameters: z.object({ query: z.string().min(1).max(1000) }),
			async execute({ query }, _context, details) {
				grant.assertActive();
				const result = await runBounded(
					[
						"git",
						"grep",
						"--no-index",
						"--exclude-standard",
						"-n",
						"-I",
						"-F",
						"--",
						query,
						".",
						":(exclude).git",
					],
					{
						cwd: grant.cwd,
						env: toolEnvironment(modelKeys),
						maxOutputBytes: 32768,
						timeoutMs: 10000,
						signal: details?.signal
							? AbortSignal.any([grant.signal, details.signal])
							: grant.signal,
					},
				);
				grant.assertActive();
				if (result.timedOut || result.launchFailed || result.aborted)
					throw new Error("Search did not complete");
				if (result.outputLimitExceeded)
					return `${result.out}\n[Search output truncated at 32768 bytes]`;
				if (!result.ok && (result.out || result.err))
					throw new Error(`Search failed: ${result.err || result.out}`);
				return result.out;
			},
		}),
		tool({
			errorFunction: null,
			name: "bash",
			description:
				"Run a shell command in the assigned worktree, including project tests. Host permissions apply. Requires user approval.",
			parameters: z.object({
				command: z.string().min(1).max(16000),
				timeoutMs: z.number().int().min(1).max(120000),
			}),
			needsApproval: true,
			async execute({ command, timeoutMs }, _context, details) {
				grant.assertActive();
				const signal = details?.signal
					? AbortSignal.any([grant.signal, details.signal])
					: grant.signal;
				const result = await runBounded(
					process.platform === "win32"
						? ["cmd.exe", "/d", "/s", "/c", command]
						: ["/bin/sh", "-c", command],
					{
						cwd: grant.cwd,
						env: toolEnvironment(modelKeys),
						maxOutputBytes: 32768,
						signal,
						timeoutMs,
					},
				);
				grant.assertActive();
				return {
					...result,
					isError: !result.ok,
					out: result.out.slice(0, 32768),
					err: result.err.slice(0, 32768),
				};
			},
		}),
		tool({
			errorFunction: null,
			name: "apply_patch",
			description:
				"Create or update one file with a V4A diff. Supply exact original file text, or null for a new file. Requires user approval.",
			parameters: z.object({
				path: z.string().min(1),
				diff: z.string().min(1).max(524288),
				original: z.string().max(262144).nullable(),
			}),
			needsApproval: true,
			execute(input) {
				return applyWorkspacePatch(grant, input);
			},
		}),
	];
}

import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function applyArtifactPreset(cwd: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const path = join(cwd, relative);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
}

export const FIXTURE_MD_SUFFIX = ".test";

const MASKED_RE = /\.md\.test$/;

export function maskFixtureMarkdown(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(entry.parentPath, entry.name);
		renameSync(path, `${path}${FIXTURE_MD_SUFFIX}`);
	}
}

export function unmaskFixtureMarkdown(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !MASKED_RE.test(entry.name)) continue;
		const path = join(entry.parentPath, entry.name);
		renameSync(path, path.slice(0, -FIXTURE_MD_SUFFIX.length));
	}
}

export function includeInFixtureSnapshot(source: string): boolean {
	return !/\/\.git(\/|$)/.test(source);
}

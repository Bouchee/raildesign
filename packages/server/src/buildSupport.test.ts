import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolveBuildRuntimeSources } from "./buildSupport";

test("runtime source manifest covers the launcher artifact surface", () => {
	const sources = resolveBuildRuntimeSources();
	expect(sources.skillRoots.filter(({ route }) => route === "host")).toHaveLength(4);
	expect(sources.skillRoots.some(({ route }) => route === "extensions/web-access")).toBe(true);
	expect(sources.skillRoots.every(({ source }) => existsSync(source))).toBe(true);
	expect(
		Object.fromEntries(
			Object.entries(sources.ptyLibraries).map(([target, path]) => [target, basename(path)]),
		),
	).toEqual({
		"darwin-arm64": "librust_pty_arm64.dylib",
		"darwin-x64": "librust_pty.dylib",
		"linux-arm64": "librust_pty_arm64.so",
		"linux-x64": "librust_pty.so",
		"win32-x64": "rust_pty.dll",
	});
	expect(basename(sources.trashHelpers.macos)).toBe("macos-trash");
	expect(basename(sources.trashHelpers.windows)).toBe("windows-trash.exe");
});

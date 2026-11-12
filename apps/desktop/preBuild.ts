import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { BuildRuntimeSources } from "@thinkrail/server/build-support";
import { ptyLibraryName, runtimeTarget } from "./src/runtimeTarget";

const desktopDir = import.meta.dir;
const repoRoot = resolve(desktopDir, "..", "..");
const stageDir = join(desktopDir, ".stage");
const runtimeDir = join(stageDir, "runtime");
const generatedEntry = join(stageDir, "server-entry.ts");
function runBun(args: string[]): void {
	const result = spawnSync("bun", args, { cwd: repoRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`bun ${args.join(" ")} exited ${result.status ?? result.signal}`);
	}
}

function resolveRuntimeSources(): BuildRuntimeSources {
	const result = spawnSync(
		"bun",
		[
			"--print",
			'JSON.stringify((await import("@thinkrail/server/build-support")).resolveBuildRuntimeSources())',
		],
		{ cwd: desktopDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`build-support manifest exited ${result.status ?? result.signal}`);
	}
	return JSON.parse(result.stdout) as BuildRuntimeSources;
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

runBun(["run", "build:web"]);
const webMaps = listFiles(join(repoRoot, "apps", "web", "dist")).filter((file) =>
	file.endsWith(".map"),
);
if (webMaps.length) throw new Error(`refusing to package web source maps: ${webMaps.join(", ")}`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
const sources = resolveRuntimeSources();
const skillRoutes = new Set<string>();
for (const skillRoot of sources.skillRoots) {
	for (const source of listFiles(skillRoot.source).sort()) {
		const route = [skillRoot.route, ...relative(skillRoot.source, source).split(sep)]
			.filter(Boolean)
			.join("/");
		if (skillRoutes.has(route)) throw new Error(`duplicate staged skill route: ${route}`);
		skillRoutes.add(route);
		const destination = join(runtimeDir, "skills", route);
		mkdirSync(join(destination, ".."), { recursive: true });
		copyFileSync(source, destination);
	}
}
const target = runtimeTarget(process.platform, process.arch);
copyFileSync(sources.ptyLibraries[target], join(runtimeDir, ptyLibraryName(target)));
for (const helper of Object.values(sources.trashHelpers)) {
	copyFileSync(helper, join(runtimeDir, basename(helper)));
}
if (process.platform !== "win32") chmodSync(join(runtimeDir, "macos-trash"), 0o755);

try {
	writeFileSync(
		generatedEntry,
		`import { bootHost, setBundledTrashHelpers, setBundledSkillPaths } from "@thinkrail/server";

export async function startDesktopHost(options) {
  setBundledSkillPaths(options.runtimeDir + "/skills");
  setBundledTrashHelpers({
    macos: options.runtimeDir + "/macos-trash",
    windows: options.runtimeDir + "/windows-trash.exe",
  });
  const host = await bootHost({
    port: 0,
    host: "127.0.0.1",
    portMode: "exact",
    resolveShellEnv: true,
    staticDir: options.staticDir,
    appVersion: options.appVersion,

  });
  return host;
}
`,
	);
	const runtimeFile = join(runtimeDir, "server-runtime.ts");
	runBun([
		"build",
		generatedEntry,
		"--target=bun",
		`--outdir=${runtimeDir}`,
		`--entry-naming=${basename(runtimeFile)}`,
	]);
} finally {
	rmSync(generatedEntry, { force: true });
}

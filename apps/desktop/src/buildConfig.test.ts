import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { version } from "@thinkrail/shared/version";
import rootManifest from "../../../package.json";
import hutchConfig from "../hutch.config";
import manifest from "../package.json";

const desktopDir = resolve(import.meta.dir, "..");

test("selects real Bun and preserves the physical runtime resources without retired v1 fields", () => {
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--eval",
			'const { default: config } = await import("./electrobun.config.ts"); console.log(JSON.stringify(config));',
		],
		{
			cwd: desktopDir,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(result.exitCode).toBe(0);
	const config = JSON.parse(result.stdout.toString());
	expect(config.app).toEqual({
		name: "RailDesign",
		identifier: "io.github.bouchee.raildesign",
		version,
	});
	expect(config.runtime).toEqual({ exitOnLastWindowClosed: true });
	expect(config.build).toMatchObject({
		mainProcess: "bun",
		bun: { entrypoint: "src/index.ts", version: rootManifest.packageManager.replace(/^bun@/, "") },
		views: { preload: { entrypoint: "src/preload.ts", format: "iife" } },
		copy: { "../web/dist": "views/web", ".stage/runtime": "runtime" },
		mac: { bundleCEF: false, icons: "../../packages/shared/assets/icon.iconset" },
		linux: { bundleCEF: false, icon: "../../packages/shared/assets/icon.png" },
		win: { bundleCEF: false, icon: "../../packages/shared/assets/icon.ico" },
	});
	expect(config.scripts).toEqual({ preBuild: "preBuild.ts", postBuild: "postBuild.ts" });
	expect(config.build).not.toHaveProperty("bunVersion");
	expect(config.build).not.toHaveProperty("useAsar");
});

test("development packaging has only the fork update channel and no telemetry upload", async () => {
	const { default: config } = await import("../electrobun.config");
	expect(config.release.baseUrl).toBe(
		"https://github.com/Bouchee/thinkrail/releases/download/desktop-updates",
	);
	const source = readFileSync(resolve(desktopDir, "preBuild.ts"), "utf8");
	expect(source).not.toContain("posthog");
	expect(source).not.toContain("startAttributionClaim");
});

test("uses the exact npm bootstrap pin while Bun owns the workspace dependency graph", () => {
	expect(manifest.devDependencies.electrobun).toBe("2.0.5");
	expect(manifest.dependencies).not.toHaveProperty("electrobun");
	expect(hutchConfig).toEqual({ packageManager: "bun" });
});

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { assertLivePlaywrightRunner } from "./agentRunPlan";
import { hermeticE2ePath, hermeticE2eShell, resolveBunExecutable } from "./fixtures/executables";
import {
	E2E_DATA_DIR,
	E2E_EDITOR_LOG,
	E2E_FAKE_BIN_DIR,
	E2E_HOME_DIR,
	E2E_INSTALLED_FONTS,
	E2E_PICK_DIR_POINTER,
	E2E_PORT,
	E2E_SPEECH_MANIFEST,
} from "./fixtures/paths";
import { isLiveAgentE2e, LIVE_AGENT_E2E_ENV } from "./fixtures/sdkAgent";
import { REAL_SPEECH_E2E_ENV } from "./fixtures/speech";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const staticDir = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
// Per-worktree derived port (e2e/fixtures/paths.ts) — parallel worktrees (this product's own working
// model) run their suites concurrently without fighting over one port, zero config; the dev host
// (24242) stays clear. Slot clashes are auto-arbitrated by an atomic claim registry
// (e2e/fixtures/portBlock.ts). Supersedes the manual THINKRAIL_E2E_PORT knob
// (THINKRAIL_E2E_PORT_BASE pins the whole per-worktree block explicitly when ever needed).
const PORT = E2E_PORT;
const liveMode = isLiveAgentE2e();
assertLivePlaywrightRunner(process.env, process.argv);
const bunExecutable = resolveBunExecutable();
const hostPath = hermeticE2ePath(E2E_FAKE_BIN_DIR);
if (hostPath.split(delimiter).some((directory) => existsSync(join(directory, "pi"))))
	throw new Error("e2e host PATH must not contain pi");
const hostCommand =
	process.env.THINKRAIL_E2E_SKIP_BUILD === "1"
		? `${JSON.stringify(bunExecutable)} packages/server/src/dev.ts`
		: `${JSON.stringify(bunExecutable)} run build:web && ${JSON.stringify(bunExecutable)} packages/server/src/dev.ts`;
export default defineConfig({
	testDir: ".",
	// The headless workflow-test suite has its own config (e2e/playwright.workflows.config.ts) — no browser,
	// no webServer; `bun run test:workflow-helpers`. Never picked up by the browser suites.
	testIgnore: "workflows/**",
	...(liveMode ? { grep: /@agent/ } : { grepInvert: /@agent/ }),
	// One worker owns one stateful host; the shard runner deals tests to lanes through test lists.
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: 30_000,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never", outputFolder: "../playwright-report" }]]
		: "list",
	outputDir: "../test-results",
	globalSetup: "./global-setup.ts",
	globalTeardown: "./global-teardown.ts",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			testMatch: /(?:^|[\\/])(?:ask-user-question|ask-previews|plan-ask)\.spec\.ts$/,
		},
	],
	// Self-contained: build the web app, boot the host on an isolated port + state dir, and tear it all
	// down after. `bun run e2e` needs nothing else running.
	webServer: {
		command: hostCommand,
		cwd: rootDir,
		url: `http://localhost:${PORT}/health`,
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			THINKRAIL_PORT: String(PORT),
			THINKRAIL_STATIC_DIR: staticDir,
			THINKRAIL_DATA_DIR: E2E_DATA_DIR,
			DISPLAY: "",
			WAYLAND_DISPLAY: "",
			// Stub the host's native directory picker so "Open project" is drivable headlessly. It names a
			// control *file* (seeded to the git fixture in globalSetup); a test can rewrite it to hand the
			// picker a different folder (e.g. a non-git one) without restarting the shared host.
			THINKRAIL_PICK_DIR: E2E_PICK_DIR_POINTER,
			// The host's installed-font list, read from this file per request instead of the OS font service.
			THINKRAIL_INSTALLED_FONTS: E2E_INSTALLED_FONTS,
			// Voice input installs from a local fake engine and tiny model, never NVIDIA's servers —
			// except in the opt-in real-engine run (voice-input.real.spec.ts).
			...(process.env[REAL_SPEECH_E2E_ENV] === "1"
				? {}
				: { THINKRAIL_SPEECH_MANIFEST: E2E_SPEECH_MANIFEST }),
			// Force the New-Workspace dialog's `gh` probe to "Not connected" so the suite is deterministic
			// regardless of the dev machine's real `gh` auth — and exercises the offline/local-branch degrade path.
			THINKRAIL_GH_OFFLINE: "1",
			// Keep cross-agent personal skill aliases away from the developer's real homes/overrides.
			...toolHomeEnv(E2E_HOME_DIR),
			PATH: hostPath,
			SHELL: hermeticE2eShell(E2E_FAKE_BIN_DIR),
			...(liveMode
				? {
						[LIVE_AGENT_E2E_ENV]: "1",
					}
				: {}),
			// Where the stub `code` appends each invocation's argv, so a test can assert "Open in VS Code"
			// actually launched with the right worktree path.
			THINKRAIL_E2E_EDITOR_LOG: E2E_EDITOR_LOG,
			CI: "1",
		},
	},
});

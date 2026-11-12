import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	assertLivePlaywrightRunner,
	createAgentRunPlan,
	LIVE_PLAYWRIGHT_RUNNER_AUTH_ENV,
	WEB_BUILD_READY_ENV,
} from "./agentRunPlan";
import {
	AMBIENT_MODEL_CREDENTIAL_ENV_NAMES,
	stripAmbientModelCredentials,
} from "./ambientCredentials";
import { resolveBunExecutable } from "./fixtures/executables";
import {
	DEFAULT_E2E_MODEL,
	isExactE2eModel,
	isLiveAgentE2e,
	LIVE_AGENT_E2E_ENV,
	readLiveAgentKey,
	resolveE2eModel,
	seedAgentConfiguration,
} from "./fixtures/sdkAgent";
import { countSelectedPlaywrightTests, selectFocusedFullRunPhases } from "./fullRunPlan";
import { e2eProcessDetached, signalExitCode } from "./processRunner";

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "thinkrail-agent-harness-"));
}

test("SDK test setup keeps no-agent configuration free of keys", () => {
	const root = temporaryDirectory();
	try {
		seedAgentConfiguration(root, {});
		const config = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
		expect(config.endpoints[0].baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
		expect(config.endpoints[0].apiKey).toBe("");
		expect(config.endpoints[0].models[0].id).toBe("deepseek-v4.1-flash");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("live setup rejects unprotected keys and a different endpoint", () => {
	const root = temporaryDirectory();
	const path = join(root, "live.json");
	const config = {
		apiKey: "test-only-key",
		baseURL: "https://opencode.ai/inference/go/openai/v1",
		model: "deepseek-v4.1-flash",
	};
	try {
		writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
		expect(readLiveAgentKey(path)).toBe("test-only-key");
		writeFileSync(path, JSON.stringify({ ...config, baseURL: "https://example.test/v1" }));
		expect(() => readLiveAgentKey(path)).toThrow(/verified Go\/DeepSeek/);
		if (process.platform !== "win32") {
			writeFileSync(path, JSON.stringify(config));
			chmodSync(path, 0o644);
			expect(() => readLiveAgentKey(path)).toThrow(/only by its owner/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("agent model parsing preserves provider-qualified ids and rejects malformed targets", () => {
	expect(resolveE2eModel({})).toEqual({ provider: "custom-e2e", id: "deepseek-v4.1-flash" });
	expect(DEFAULT_E2E_MODEL).toBe("custom-e2e/deepseek-v4.1-flash");
	expect(resolveE2eModel({ THINKRAIL_E2E_MODEL: "gateway/team/model" })).toEqual({
		provider: "gateway",
		id: "team/model",
	});
	for (const value of ["", "provider", "/model", "provider/"]) {
		expect(() => resolveE2eModel({ THINKRAIL_E2E_MODEL: value })).toThrow(/provider\/modelId/);
	}
});

test("exact model matching never accepts the first model from another provider", () => {
	const target = { provider: "anthropic", id: "same-id" };
	expect(isExactE2eModel({ provider: "anthropic", id: "same-id" }, target)).toBe(true);
	expect(isExactE2eModel({ provider: "local", id: "same-id" }, target)).toBe(false);
	expect(isExactE2eModel({ provider: "anthropic", id: "near-id" }, target)).toBe(false);
	expect(isExactE2eModel(null, target)).toBe(false);
});

test("ambient credential removal is case-insensitive", () => {
	const env: NodeJS.ProcessEnv = {
		aNtHrOpIc_ApI_kEy: "secret",
		AwS_pRoFiLe: "developer",
		UNRELATED_E2E_ENV: "preserved",
	};
	expect(stripAmbientModelCredentials(env)).toBe(env);
	expect(env).toEqual({ UNRELATED_E2E_ENV: "preserved" });
});

test("Live SDK Playwright execution requires the public runner authorization and skip-build", () => {
	const centralEnv = { [LIVE_AGENT_E2E_ENV]: "1" };
	expect(() => assertLivePlaywrightRunner(centralEnv, [])).toThrow(/e2e:agent.*e2e:full/);
	expect(() =>
		assertLivePlaywrightRunner({ ...centralEnv, THINKRAIL_E2E_SKIP_BUILD: "1" }, []),
	).toThrow(/e2e:agent.*e2e:full/);
	const plan = createAgentRunPlan("bun", [], centralEnv);
	expect(() => assertLivePlaywrightRunner(plan.env, [])).not.toThrow();
	expect(() => assertLivePlaywrightRunner(centralEnv, ["--list"])).not.toThrow();
	expect(() => assertLivePlaywrightRunner({}, [])).not.toThrow();
});

test("agent run plan ignores ambient skip, trusts only internal build readiness, and sanitizes Playwright", () => {
	const ambientCredentials = Object.fromEntries(
		AMBIENT_MODEL_CREDENTIAL_ENV_NAMES.map((name) => [name, `ambient-${name}`]),
	);
	const sourceEnv: NodeJS.ProcessEnv = {
		...ambientCredentials,
		PATH: "/developer/bin:/usr/bin",
		UNRELATED_E2E_ENV: "preserved",
		THINKRAIL_E2E_SKIP_BUILD: "1",
		THINKRAIL_E2E_LANE: "4",
		PLAYWRIGHT_BLOB_OUTPUT_FILE: "/tmp/report.zip",
	};
	const plan = createAgentRunPlan("/developer/bin/bun", ["e2e/agent.live.spec.ts"], sourceEnv);
	expect(plan.buildCommand).toEqual(["/developer/bin/bun", "run", "build:web"]);
	expect(plan.playwrightCommand).toEqual([
		"/developer/bin/bun",
		"x",
		"playwright",
		"test",
		"-c",
		"e2e/playwright.config.ts",
		"e2e/agent.live.spec.ts",
		"--workers=1",
	]);
	expect(plan.env.PATH).toBe(sourceEnv.PATH);
	expect(plan.env.UNRELATED_E2E_ENV).toBe("preserved");
	for (const name of AMBIENT_MODEL_CREDENTIAL_ENV_NAMES) {
		expect(plan.env[name]).toBeUndefined();
		expect(sourceEnv[name]).toBe(`ambient-${name}`);
	}
	expect(plan.env.THINKRAIL_E2E_SKIP_BUILD).toBe("1");
	expect(plan.env[LIVE_PLAYWRIGHT_RUNNER_AUTH_ENV]).toBe("1");
	expect(plan.env[LIVE_AGENT_E2E_ENV]).toBe("1");
	expect(plan.env.THINKRAIL_E2E_LANE).toBeUndefined();
	expect(plan.env.PLAYWRIGHT_BLOB_OUTPUT_FILE).toBeUndefined();
	expect(plan.env[WEB_BUILD_READY_ENV]).toBeUndefined();
	expect(isLiveAgentE2e(plan.env)).toBe(true);
	expect(
		createAgentRunPlan("bun", ["e2e/agent.live.spec.ts"], sourceEnv, {
			webBuildReady: true,
		}).buildCommand,
	).toBeNull();
	expect(createAgentRunPlan("bun", ["--list"], sourceEnv).buildCommand).toBeNull();
});

test("focused full-run planning skips empty phases and rejects an empty selection", () => {
	const report = JSON.stringify({
		suites: [
			{
				specs: [{ tests: [{}, {}] }],
				suites: [{ specs: [{ tests: [{}] }], suites: [] }],
			},
		],
		errors: [],
	});
	const emptyReport = JSON.stringify({
		suites: [],
		errors: [{ message: "Error: No tests found." }],
	});
	expect(countSelectedPlaywrightTests(report)).toBe(3);
	expect(countSelectedPlaywrightTests(emptyReport)).toBe(0);
	expect(selectFocusedFullRunPhases(0, 2)).toEqual(["agent"]);
	expect(selectFocusedFullRunPhases(2, 0)).toEqual(["no-agent"]);
	expect(selectFocusedFullRunPhases(2, 3)).toEqual(["no-agent", "agent"]);
	expect(() => selectFocusedFullRunPhases(0, 0)).toThrow(/No tests matched/);
	expect(() =>
		countSelectedPlaywrightTests(
			JSON.stringify({ suites: [], errors: [{ message: "configuration failed" }] }),
		),
	).toThrow(/configuration failed/);
});

test("managed E2E roots preserve hidden Windows consoles and POSIX process groups", () => {
	expect(e2eProcessDetached("win32")).toBe(false);
	expect(e2eProcessDetached("linux")).toBe(true);
	expect(e2eProcessDetached("darwin")).toBe(true);
});

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function forceKillFixtureProcess(pid: number): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {}
	}
}

interface SignalTreeState {
	innerRunner: number;
	child: number;
	grandchild: number;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	test(`nested managed runner preserves cleanup and kills every descendant after ${signal}`, async () => {
		test.skip(process.platform === "win32");
		test.setTimeout(10_000);
		const root = temporaryDirectory();
		const statePath = join(root, `signal-tree-${signal}.json`);
		const cleanupPath = join(root, `signal-tree-${signal}.cleaned`);
		const runner = spawn(
			resolveBunExecutable(),
			["e2e/fixtures/nested-signal-runner.ts", statePath, cleanupPath],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				stdio: "ignore",
			},
		);
		let state: SignalTreeState | null = null;
		try {
			await expect.poll(() => existsSync(statePath), { timeout: 3_000 }).toBe(true);
			const runningState = JSON.parse(readFileSync(statePath, "utf8")) as SignalTreeState;
			state = runningState;
			expect(processExists(runningState.innerRunner)).toBe(true);
			expect(processExists(runningState.child)).toBe(true);
			expect(processExists(runningState.grandchild)).toBe(true);
			const startedAt = Date.now();
			const exited = new Promise<number>((resolve, reject) => {
				runner.once("error", reject);
				runner.once("exit", (code) => resolve(code ?? 1));
			});
			runner.kill(signal);
			expect(await exited).toBe(signalExitCode(signal));
			expect(Date.now() - startedAt).toBeLessThan(3_000);
			expect(JSON.parse(readFileSync(cleanupPath, "utf8"))).toEqual({ grandchildAlive: true });
			await expect
				.poll(
					() =>
						!processExists(runningState.innerRunner) &&
						!processExists(runningState.child) &&
						!processExists(runningState.grandchild),
					{ timeout: 3_000 },
				)
				.toBe(true);
		} finally {
			runner.kill("SIGKILL");
			if (state) {
				forceKillFixtureProcess(state.innerRunner);
				forceKillFixtureProcess(state.child);
				forceKillFixtureProcess(state.grandchild);
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
}

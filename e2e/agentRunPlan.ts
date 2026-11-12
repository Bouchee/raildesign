import { stripAmbientModelCredentials } from "./ambientCredentials";
import { isLiveAgentE2e, LIVE_AGENT_E2E_ENV } from "./fixtures/sdkAgent";
import { PLAYWRIGHT_CONFIG } from "./processRunner";

export const LIVE_PLAYWRIGHT_RUNNER_AUTH_ENV = "RAILDESIGN_E2E_LIVE_RUNNER_AUTHORIZED";
export const WEB_BUILD_READY_ENV = "THINKRAIL_E2E_WEB_BUILD_READY";

export interface AgentRunPlan {
	buildCommand: string[] | null;
	playwrightCommand: string[];
	env: NodeJS.ProcessEnv;
}

export function assertLivePlaywrightRunner(env: NodeJS.ProcessEnv, args: readonly string[]): void {
	const authorized =
		env.THINKRAIL_E2E_SKIP_BUILD === "1" && env[LIVE_PLAYWRIGHT_RUNNER_AUTH_ENV] === "1";
	if (isLiveAgentE2e(env) && !authorized && !args.includes("--list")) {
		throw new Error(
			"Live SDK Playwright execution must use `bun run e2e:agent` or `bun run e2e:full`",
		);
	}
}

export function createAgentRunPlan(
	bun: string,
	playwrightArgs: string[],
	env: NodeJS.ProcessEnv = process.env,
	options: { webBuildReady?: boolean } = {},
): AgentRunPlan {
	const listOnly = playwrightArgs.includes("--list");
	const buildCommand =
		listOnly || options.webBuildReady === true ? null : [bun, "run", "build:web"];
	const childEnv = stripAmbientModelCredentials({
		...env,
		THINKRAIL_E2E_SKIP_BUILD: "1",
		[LIVE_AGENT_E2E_ENV]: "1",
	});
	childEnv[LIVE_PLAYWRIGHT_RUNNER_AUTH_ENV] = "1";
	delete childEnv[WEB_BUILD_READY_ENV];
	delete childEnv.THINKRAIL_E2E_LANE;
	delete childEnv.PLAYWRIGHT_BLOB_OUTPUT_FILE;
	return {
		buildCommand,
		playwrightCommand: [
			bun,
			"x",
			"playwright",
			"test",
			"-c",
			PLAYWRIGHT_CONFIG,
			...playwrightArgs,
			"--workers=1",
		],
		env: childEnv,
	};
}

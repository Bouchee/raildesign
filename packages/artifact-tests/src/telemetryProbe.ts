import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@thinkrail/shared/removeTree";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import {
	type ArtifactHostAdapter,
	hostEnvironment,
	type RunningArtifactHost,
} from "./artifactProbes";

export function startTelemetryCollector() {
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return Response.json({ status: "ok", surveys: [] });
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

export function assertNoTelemetry(requests: readonly string[]): void {
	if (requests.length !== 0)
		throw new Error(`unexpected telemetry requests: ${requests.join(", ")}`);
}

export function telemetryProbeEnvironment(
	root: string,
	collectorOrigin: string,
	inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const endpoint = new URL(collectorOrigin);
	if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.port === "")
		throw new Error("telemetry probe requires a loopback collector");
	return hostEnvironment(
		{
			...toolHomeEnv(join(root, "home")),
			LOCALAPPDATA: join(root, "local"),
			APPDATA: join(root, "roaming"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "xdg-data"),
			XDG_CACHE_HOME: join(root, "cache"),
			THINKRAIL_DATA_DIR: join(root, "data"),
			THINKRAIL_POSTHOG_HOST: endpoint.origin,
			NO_PROXY: "127.0.0.1,localhost",
		},
		[
			"CI",
			"NODE_ENV",
			"THINKRAIL_NO_ANALYTICS",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"OPENAI_BASE_URL",
			"OPENAI_MODEL",
			"OPENAI_API_KEY",
		],
		inherited,
	);
}

export async function runTelemetryProbe(adapter: ArtifactHostAdapter): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "raildesign-no-telemetry-"));
	const collector = startTelemetryCollector();
	let host: RunningArtifactHost | undefined;
	try {
		const env = telemetryProbeEnvironment(root, collector.origin);
		mkdirSync(env.HOME ?? join(root, "home"), { recursive: true });
		for (const label of ["first-launch", "restart"]) {
			host = await adapter.launch(env, label);
			const health = await fetch(`${host.origin}/health`, { signal: AbortSignal.timeout(10000) });
			if (!health.ok || (await health.text()) !== "ok")
				throw new Error(`${label} host is not healthy`);
			await host.stop();
			host = undefined;
			assertNoTelemetry(collector.requests);
		}
		console.log(
			"telemetry probe OK: launch and restart made no telemetry or survey requests to the regression collector.",
		);
	} finally {
		try {
			await host?.stop();
		} finally {
			collector.stop();
			removeTree(root);
		}
	}
}

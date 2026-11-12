import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	assertNoTelemetry,
	startTelemetryCollector,
	telemetryProbeEnvironment,
} from "./telemetryProbe";

test("negative telemetry probing is isolated, unmuted and clears provider credentials", () => {
	const inherited = {
		ci: "1",
		node_env: "test",
		Home: "real-home",
		UserProfile: "real-profile",
		openai_api_key: "real-secret",
		thinkrail_posthog_host: "https://production.invalid",
		https_proxy: "https://proxy.invalid",
		PATH: "test-path",
	};
	const env = telemetryProbeEnvironment("isolated", "http://127.0.0.1:12345", inherited);
	expect(env.HOME).toBe(join("isolated", "home"));
	expect(env.USERPROFILE).toBe(env.HOME);
	expect(env.THINKRAIL_DATA_DIR).toBe(join("isolated", "data"));
	expect(env.THINKRAIL_POSTHOG_HOST).toBe("http://127.0.0.1:12345");
	expect(env.PATH).toBe("test-path");
	for (const key of [
		"ci",
		"node_env",
		"Home",
		"UserProfile",
		"openai_api_key",
		"https_proxy",
		"CI",
		"NODE_ENV",
		"OPENAI_API_KEY",
	])
		expect(env[key]).toBeUndefined();
});

test("telemetry probes cannot send controlled traffic to an external collector", () => {
	for (const origin of ["https://production.invalid", "http://0.0.0.0:1234", "http://127.0.0.1"])
		expect(() => telemetryProbeEnvironment("isolated", origin)).toThrow("loopback collector");
});

test("any event or survey request fails the negative assertion", async () => {
	const collector = startTelemetryCollector();
	try {
		assertNoTelemetry(collector.requests);
		await fetch(`${collector.origin}/batch/`, { method: "POST", body: "event" });
		await fetch(`${collector.origin}/api/surveys/`);
		expect(collector.requests).toEqual(["POST /batch/", "GET /api/surveys/"]);
		expect(() => assertNoTelemetry(collector.requests)).toThrow("unexpected telemetry requests");
	} finally {
		collector.stop();
	}
});

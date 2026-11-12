import { expect, test } from "bun:test";
import { hostEnvironment } from "./artifactProbes";

test("isolates both home variables without inheriting Windows case variants", () => {
	const inherited = {
		Home: "real-home",
		HOME: "another-real-home",
		UserProfile: "real-profile",
		Path: "real-path",
		SystemRoot: "system-root",
		UNDEFINED: undefined,
	};
	expect(
		hostEnvironment(
			{ HOME: "isolated-home", USERPROFILE: "isolated-home", PATH: "isolated-path" },
			[],
			inherited,
		),
	).toEqual({
		HOME: "isolated-home",
		USERPROFILE: "isolated-home",
		PATH: "isolated-path",
		SystemRoot: "system-root",
	});
	expect(inherited.UserProfile).toBe("real-profile");
});

test("unsets inherited model-key case variants for isolated artifact probes", () => {
	expect(
		hostEnvironment({}, ["OPENAI_API_KEY"], {
			openai_api_key: "real-key",
			OPENAI_API_KEY: "another-real-key",
			HOME: "isolated-home",
			USERPROFILE: "isolated-home",
		}),
	).toEqual({ HOME: "isolated-home", USERPROFILE: "isolated-home" });
});

test("native UI and host modes replace inherited control seams without retaining the other mode", () => {
	const inherited = {
		thinkrail_desktop_e2e_host: "1",
		thinkrail_desktop_navigation_probe_file: "real-navigation-file",
		thinkrail_desktop_ready_file: "real-ready-file",
		thinkrail_desktop_control_file: "real-control-file",
		HOME: "isolated-home",
		USERPROFILE: "isolated-home",
	};
	const modes: Record<string, string>[] = [
		{ THINKRAIL_DESKTOP_E2E_HOST: "1" },
		{ THINKRAIL_DESKTOP_NAVIGATION_PROBE_FILE: "isolated-navigation-file" },
	];
	for (const mode of modes) {
		const overrides = {
			...mode,
			THINKRAIL_DESKTOP_READY_FILE: "isolated-ready-file",
			THINKRAIL_DESKTOP_CONTROL_FILE: "isolated-control-file",
		};
		expect(
			hostEnvironment(
				overrides,
				["THINKRAIL_DESKTOP_E2E_HOST", "THINKRAIL_DESKTOP_NAVIGATION_PROBE_FILE"],
				inherited,
			),
		).toEqual({ ...overrides, HOME: "isolated-home", USERPROFILE: "isolated-home" });
	}
});

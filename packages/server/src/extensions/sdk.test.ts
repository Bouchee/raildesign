import { expect, test } from "bun:test";
import type { SdkToolServices } from "@thinkrail/extension-api/server";
import { registrySdkTools, snapshotSdkExtensions } from "./sdk";

const services: Omit<SdkToolServices, "setting"> = {
	cwd: "/workspace",
	assertActive: () => {},
	toolResponse: () => ({ kind: "deferred" }),
	markToolFailed: () => {},
	workspaceFiles: { check: async () => {}, scratchDir: "" },
	webAccess: { search: async () => "", fetch: async () => "" },
};

test("SDK extension snapshots freeze declared settings and exclude disabled factories", () => {
	const settings = { "ask-user-question": { richPreviews: false } };
	const snapshot = snapshotSdkExtensions(["visualize"], settings);
	settings["ask-user-question"].richPreviews = true;
	expect(snapshot.map((item) => item.name)).toEqual(["ask-user-question", "web-access"]);
	expect(snapshot[0]?.settings).toEqual({ richPreviews: false });
	expect(
		registrySdkTools(services, snapshot).flatMap((tool) =>
			tool.type === "function" ? [tool.name] : [],
		),
	).toEqual(["ask_user_question", "web_search", "web_fetch"]);
});

test("child graphs contain only explicit child factories", () => {
	const snapshot = snapshotSdkExtensions([], {}, "child");
	expect(snapshot.map((item) => item.name)).toEqual(["web-access"]);
	expect(
		registrySdkTools(services, snapshot, "child").flatMap((tool) =>
			tool.type === "function" ? [tool.name] : [],
		),
	).toEqual(["web_search", "web_fetch"]);
});

test("SDK recovery refuses missing factories and missing settings", () => {
	expect(() => registrySdkTools(services, [{ name: "missing", settings: {} }])).toThrow(
		"unavailable",
	);
	expect(() => registrySdkTools(services, [{ name: "ask-user-question", settings: {} }])).toThrow(
		"Unknown extension setting",
	);
});

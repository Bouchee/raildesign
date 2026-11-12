import { describe, expect, it, mock } from "bun:test";
import { tool } from "@openai/agents";
import { listExtensionCatalog } from "./catalog";
import type { ServerExtensionEntry } from "./registry";

const namedTool = (name: string) =>
	tool({
		name,
		description: name,
		strict: false,
		parameters: { type: "object", properties: {}, required: [], additionalProperties: true },
		execute: () => name,
	});

describe("listExtensionCatalog", () => {
	it("lists shipped SDK tool names and extension state", async () => {
		const entries = await listExtensionCatalog(new Set(["visualize"]));
		expect(entries.map((entry) => entry.name)).toEqual([
			"visualize",
			"ask-user-question",
			"web-access",
		]);
		expect(entries[0]).toMatchObject({
			tools: ["visualize"],
			enabled: false,
			hasChildExtensions: false,
		});
		expect(entries[1]).toMatchObject({
			tools: ["ask_user_question"],
			enabled: true,
			settings: [{ key: "richPreviews", default: true }],
		});
	});

	it("uses declared default settings and does not execute parent or child tools", async () => {
		const execute = mock(() => "unused");
		const child = mock(() => [namedTool("child")]);
		const values: boolean[] = [];
		const entries: ServerExtensionEntry[] = [
			{
				specifier: "@acme/demo/server",
				extension: {
					name: "demo",
					settings: { rich: { type: "boolean", default: false } },
					sdkTools: (session) => {
						values.push(session.setting("rich"));
						return [
							tool({
								name: "demo",
								description: "demo",
								strict: false,
								parameters: {
									type: "object",
									properties: {},
									required: [],
									additionalProperties: true,
								},
								execute,
							}),
							namedTool("demo"),
						];
					},
					sdkChildTools: child,
				},
			},
			{ specifier: "@acme/bare/server", extension: { name: "bare" } },
		];
		expect(await listExtensionCatalog(new Set(["bare"]), entries)).toEqual([
			{
				name: "demo",
				title: "demo",
				enabled: true,
				tools: ["demo"],
				hasChildExtensions: true,
				settings: [{ key: "rich", default: false }],
			},
			{ name: "bare", title: "bare", enabled: false, tools: [], hasChildExtensions: false },
		]);
		await listExtensionCatalog(new Set(), entries);
		expect(values).toEqual([false]);
		expect(execute).not.toHaveBeenCalled();
		expect(child).not.toHaveBeenCalled();
	});

	it("refuses a factory that tries to use live services in the Settings catalog", async () => {
		const entries: ServerExtensionEntry[] = [
			{
				specifier: "@acme/live/server",
				extension: {
					name: "live",
					sdkTools(session) {
						session.assertActive();
						return [];
					},
				},
			},
		];
		await expect(listExtensionCatalog(new Set(), entries)).rejects.toThrow("no active session");
	});
});

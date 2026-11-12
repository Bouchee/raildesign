import { describe, expect, it } from "bun:test";
import type { SlashCommandInfo } from "@thinkrail/contracts";
import { currentTranslator } from "@thinkrail/locales/react";
import {
	isModelCommand,
	mergeNativeChatCommands,
	nativeChatCommands,
	parseModelCommand,
	parseNativeChatCommand,
	prepareNameChatCommand,
} from "./nativeCommands";

function command(name: string, source: SlashCommandInfo["source"] = "extension"): SlashCommandInfo {
	return {
		name,
		description: `${name} description`,
		source,
		sourceInfo: {
			path: `/${source}/${name}`,
			source: "fixture",
			scope: "project",
			origin: "top-level",
		},
	};
}

describe("native chat command parsing", () => {
	it("does not intercept unsupported compaction as a host operation", () => {
		for (const text of ["/compact", "/compact keep exact filenames", "/compact "]) {
			expect(parseNativeChatCommand(text, true)).toBeNull();
		}
		expect(nativeChatCommands(currentTranslator()).map(({ name }) => name)).toEqual([
			"name",
			"model",
		]);
	});

	it("parses name only when the connected host supports its mutation", () => {
		expect(parseNativeChatCommand("/name Fix auth redirect", true)).toEqual({
			kind: "name",
			title: "Fix auth redirect",
		});
		expect(parseNativeChatCommand("/name", true)).toEqual({ kind: "name", title: "" });
		expect(parseNativeChatCommand("/name ", true)).toEqual({ kind: "name", title: "" });
		expect(parseNativeChatCommand("/name Fix auth", false)).toBeNull();
	});

	it("validates name command text and attached-image loss before submission", () => {
		expect(prepareNameChatCommand("  Fix auth\r\nredirect  ", false)).toEqual({
			title: "Fix auth redirect",
		});
		expect(prepareNameChatCommand("", false)).toEqual({ reason: "Enter a chat name." });
		expect(prepareNameChatCommand("x".repeat(81), false)).toEqual({
			reason: "Keep chat names to 80 characters or fewer.",
		});
		expect(prepareNameChatCommand("Fix auth", true)).toEqual({
			reason: "Remove images to use /name",
		});
	});

	it("leaves every near-miss for the ordinary prompt path", () => {
		for (const text of [
			"/Compact",
			"/compactness",
			"/compact\tkeep files",
			"hello /compact",
			" /compact",
		]) {
			expect(parseNativeChatCommand(text)).toBeNull();
		}
	});
});

describe("native chat command catalog", () => {
	it("orders supported built-ins first and reserves only their exact names", () => {
		const merged = mergeNativeChatCommands(
			currentTranslator(),
			[command("review"), command("name"), command("skill:name", "skill"), command("Compact")],
			true,
		);

		expect(merged.map(({ name }) => name)).toEqual([
			"name",
			"model",
			"review",
			"skill:name",
			"Compact",
		]);
		expect(merged[0]).toEqual(nativeChatCommands(currentTranslator())[0]);
		expect(merged[0]?.source).toBe("builtin");
		expect(merged[1]?.source).toBe("builtin");
		expect(
			mergeNativeChatCommands(currentTranslator(), [command("name")], false).map(
				({ name }) => name,
			),
		).toEqual(["model", "name"]);
	});

	it("recognizes only the built-in /model and hands its search text to the picker", () => {
		expect(isModelCommand(command("model"))).toBe(false);
		expect(isModelCommand({ name: "model", source: "builtin" })).toBe(true);
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("/model opus high ")).toBe("opus high");
		expect(parseModelCommand("/models")).toBeNull();
		expect(parseModelCommand("/model\topus")).toBeNull();
		expect(parseModelCommand("hello /model")).toBeNull();
	});
});

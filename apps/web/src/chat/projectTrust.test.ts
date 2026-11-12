import { describe, expect, test } from "bun:test";
import type { ProjectTrustSummary } from "@thinkrail/contracts";
import { currentTranslator } from "@thinkrail/locales/react";
import {
	canStopTrusting,
	deriveProjectTrustNotice,
	stopTrustingText,
	trustEnablesText,
	trustedNoticeText,
	trustGrantParams,
	untrustedNoticeText,
} from "./projectTrust";

const t = currentTranslator();

const summary = (over: Partial<ProjectTrustSummary> = {}): ProjectTrustSummary => ({
	aliasSkills: [],
	applicationResources: [],
	mcpServers: 0,
	...over,
});

describe("deriveProjectTrustNotice", () => {
	test("stays hidden until both the record and the summary are known, and when nothing is gated", () => {
		expect(
			deriveProjectTrustNotice(undefined, summary({ applicationResources: ["prompts"] })),
		).toEqual({
			kind: "hidden",
		});
		expect(deriveProjectTrustNotice({}, null)).toEqual({ kind: "hidden" });
		expect(deriveProjectTrustNotice({}, summary())).toEqual({ kind: "hidden" });
	});

	test("protocol 81 summaries without an MCP count keep their original trust meaning", () => {
		expect(deriveProjectTrustNotice({}, { aliasSkills: [], applicationResources: [] })).toEqual({
			kind: "hidden",
		});
		const notice = deriveProjectTrustNotice(
			{},
			{ aliasSkills: [], applicationResources: ["settings"] },
		);
		expect(notice).toMatchObject({ kind: "untrusted", mcpServers: 0 });
		if (notice.kind !== "untrusted") throw new Error("expected trust notice");
		expect(trustEnablesText(t, notice)).toBe("Trust allows reading its settings.");
	});

	test("evaluates alias and native trust separately and reports only what is still off", () => {
		const gated = summary({
			aliasSkills: ["a", "b"],
			applicationResources: ["prompts", "extensions"],
		});
		expect(deriveProjectTrustNotice({ resourceTrust: "untrusted" }, gated)).toEqual({
			kind: "untrusted",
			aliasSkills: 2,
			applicationResources: ["prompts", "extensions"],
			mcpServers: 0,
		});
		expect(deriveProjectTrustNotice({ resourceTrust: "granted" }, gated)).toEqual({
			kind: "untrusted",
			aliasSkills: 2,
			applicationResources: [],
			mcpServers: 0,
		});
		expect(
			deriveProjectTrustNotice({ trusted: true, acknowledgedSkills: ["a", "b"] }, gated),
		).toEqual({
			kind: "untrusted",
			aliasSkills: 0,
			applicationResources: ["prompts", "extensions"],
			mcpServers: 0,
		});
	});

	test("a repository whose only gated content is .raildesign/mcp.json still asks for application resource trust", () => {
		const mcpOnly = summary({ mcpServers: 2 });
		expect(deriveProjectTrustNotice({}, mcpOnly)).toEqual({
			kind: "untrusted",
			aliasSkills: 0,
			applicationResources: [],
			mcpServers: 2,
		});
		expect(deriveProjectTrustNotice({ resourceTrust: "granted" }, mcpOnly)).toEqual({
			kind: "trusted",
			aliasSkills: 0,
		});
	});

	test("after both grants it asks to review newly arrived aliases, else reads as trusted", () => {
		const granted = { trusted: true, resourceTrust: "granted" as const };
		expect(
			deriveProjectTrustNotice(
				{ ...granted, acknowledgedSkills: ["a"] },
				summary({ aliasSkills: ["a", "b"] }),
			),
		).toEqual({ kind: "unacknowledged", names: ["b"] });
		expect(
			deriveProjectTrustNotice(granted, summary({ applicationResources: ["themes"] })),
		).toEqual({
			kind: "trusted",
			aliasSkills: 0,
		});
	});
});

describe("notice copy", () => {
	const untrusted = (
		aliasSkills: number,
		applicationResources: ProjectTrustSummary["applicationResources"],
		mcpServers = 0,
	) => ({ kind: "untrusted", aliasSkills, applicationResources, mcpServers }) as const;

	test("names what is gated", () => {
		expect(untrustedNoticeText(t, untrusted(1, ["prompts"]))).toBe(
			"This project ships 1 skill and its own RailDesign resources — off until you trust it.",
		);
		expect(untrustedNoticeText(t, untrusted(3, []))).toBe(
			"This project ships 3 skills — off until you trust it.",
		);
		expect(trustedNoticeText(t, { kind: "trusted", aliasSkills: 2 })).toBe(
			"2 project skills trusted.",
		);
		expect(trustedNoticeText(t, { kind: "trusted", aliasSkills: 0 })).toBe(
			"Project resources trusted.",
		);
	});

	test("names exactly the kinds admitted without claiming configuration executes", () => {
		expect(trustEnablesText(t, untrusted(3, []))).toBeNull();
		expect(trustEnablesText(t, untrusted(0, ["prompts"]))).toBe(
			"Trust allows reading its prompts.",
		);
		expect(trustEnablesText(t, untrusted(0, ["subagents", "skills", "systemPrompt"]))).toBe(
			"Trust allows reading its skills, system prompt and subagent definitions.",
		);
		expect(trustEnablesText(t, untrusted(0, ["extensions"]))).toBe(
			"Trust allows reading its extensions.",
		);
		expect(trustEnablesText(t, untrusted(1, ["settings", "prompts", "extensions", "themes"]))).toBe(
			"Trust allows reading its prompts, themes, extensions and settings.",
		);
	});

	test("counts repository MCP servers and says each still needs approval", () => {
		expect(untrustedNoticeText(t, untrusted(0, [], 2))).toBe(
			"This project ships 2 MCP servers — off until you trust it.",
		);
		expect(trustEnablesText(t, untrusted(0, [], 1))).toBe(
			"Its 1 MCP server still needs individual approval. Connecting or testing a stdio server starts a process on this machine.",
		);
		expect(trustEnablesText(t, untrusted(0, ["extensions"], 2))).toBe(
			"Trust allows reading its extensions. Its 2 MCP servers still need individual approval. Connecting or testing a stdio server starts a process on this machine.",
		);
	});
});

test("a grant asks for application resources only when the notice named them", () => {
	expect(
		trustGrantParams("p", {
			kind: "untrusted",
			aliasSkills: 1,
			applicationResources: ["prompts"],
			mcpServers: 0,
		}),
	).toEqual({ id: "p", trusted: true, resources: true });
	expect(
		trustGrantParams("p", {
			kind: "untrusted",
			aliasSkills: 0,
			applicationResources: [],
			mcpServers: 1,
		}),
	).toEqual({ id: "p", trusted: true, resources: true });
	expect(
		trustGrantParams("p", {
			kind: "untrusted",
			aliasSkills: 1,
			applicationResources: [],
			mcpServers: 0,
		}),
	).toEqual({
		id: "p",
		trusted: true,
	});
});

test("the stop-trusting confirmation names application resources and the actual revocation scope", () => {
	const granted = { trusted: true, resourceTrust: "granted" } as const;
	expect(stopTrustingText(t, granted, true)).toBe(
		"Permission to read its project skills and RailDesign resources is revoked, and its project MCP servers are stopped.",
	);
	expect(stopTrustingText(t, { ...granted, resourceTrust: "untrusted" }, true)).toBe(
		"Permission to read its project skills is revoked.",
	);
	expect(stopTrustingText(t, granted, false)).toBe(
		"Permission to read its project skills is revoked.",
	);
});

test("Stop trusting is offered whenever either grant is held", () => {
	expect(canStopTrusting(undefined)).toBe(false);
	expect(canStopTrusting({ resourceTrust: "untrusted" })).toBe(false);
	expect(canStopTrusting({ trusted: true, resourceTrust: "untrusted" })).toBe(true);
	expect(canStopTrusting({ resourceTrust: "granted" })).toBe(true);
});

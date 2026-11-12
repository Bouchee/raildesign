import { expect, test } from "bun:test";
import type { HostEnvironmentStatus } from "@thinkrail/contracts";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentForm } from "./EnvironmentSettings";
import {
	draftChanged,
	draftFromEnvironment,
	draftIssues,
	type EnvironmentDraft,
	type EnvironmentDraftIssues,
	environmentFromDraft,
	NO_ISSUES,
} from "./environmentDraft";

const STATUS: HostEnvironmentStatus = {
	stored: {
		vars: [
			{ name: "OPENAI_API_KEY", value: "sk-secret" },
			{ name: "HTTPS_PROXY", value: "http://127.0.0.1:8888" },
		],
	},
	restartRequired: false,
	launchOverridden: [],
};

const render = (
	status: Parameters<typeof EnvironmentForm>[0]["status"],
	draft: EnvironmentDraft = typeof status === "object"
		? draftFromEnvironment(status.stored)
		: { vars: [] },
	issues: EnvironmentDraftIssues = NO_ISSUES,
	saving = false,
) =>
	renderToStaticMarkup(
		<TooltipProvider>
			<EnvironmentForm
				status={status}
				draft={draft}
				issues={issues}
				saving={saving}
				saveFailed={false}
				onChange={() => {}}
				onSave={() => {}}
				onDiscard={() => {}}
			/>
		</TooltipProvider>,
	);

test("renders masked host variables without an old agent-folder selector", () => {
	const markup = render(STATUS);
	expect(markup).toContain('value="OPENAI_API_KEY"');
	expect(markup).not.toContain("settings-environment-agent-dir");
	expect(markup).toMatch(/type="password"[^>]*value="sk-secret"/);
	expect(markup).not.toContain('data-testid="settings-environment-restart"');
	expect(markup).toMatch(/data-testid="settings-environment-save"[^>]*disabled/);
});

test("a pending restart and launch overrides are shown", () => {
	const markup = render({
		...STATUS,
		restartRequired: true,
		launchOverridden: ["HTTPS_PROXY"],
	});
	expect(markup).toContain('data-testid="settings-environment-restart"');
	expect(markup.match(/data-testid="settings-environment-var-overridden"/g)).toHaveLength(1);
});

test("issues render under their field and row", () => {
	const draft = draftFromEnvironment(STATUS.stored);
	const markup = render(STATUS, draft, {
		vars: { [draft.vars[1]?.id ?? ""]: "reserved" },
	});
	expect(markup).toContain("RailDesign manages this variable, so it can&#x27;t be set here.");
});

test("the whole form is locked while a save is in flight, so no edit can be overwritten by its response", () => {
	expect(render(STATUS)).toMatch(
		/<fieldset(?![^>]*disabled)[^>]*data-testid="settings-environment-form"/,
	);
	expect(render(STATUS, undefined, NO_ISSUES, true)).toMatch(
		/<fieldset[^>]*disabled=""[^>]*data-testid="settings-environment-form"/,
	);
});

test("loading renders nothing and failure renders a notice", () => {
	expect(render("loading")).toBe("");
	expect(render("failed")).toContain('data-testid="settings-environment-failed"');
});

test("the draft drops blank rows and maps server issue indexes back to rows", () => {
	const draft: EnvironmentDraft = {
		vars: [
			{ id: "a", name: "", value: "" },
			{ id: "b", name: " FOO ", value: "1" },
			{ id: "c", name: "PATH", value: "x" },
		],
	};
	expect(environmentFromDraft(draft)).toEqual({
		vars: [
			{ name: "FOO", value: "1" },
			{ name: "PATH", value: "x" },
		],
	});
	expect(draftIssues(draft, [{ field: "var", index: 1, code: "reserved" }])).toEqual({
		vars: { c: "reserved" },
	});
});

test("the draft is unchanged until a field differs from the stored record", () => {
	const draft = draftFromEnvironment(STATUS.stored);
	expect(draftChanged(draft, STATUS)).toBe(false);
	expect(draftChanged({ ...draft, vars: draft.vars.slice(1) }, STATUS)).toBe(true);
});

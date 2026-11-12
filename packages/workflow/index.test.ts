import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKFLOW_RULE } from "./index.ts";

describe("workflow instructions", () => {
	test("exports instructions for SDK prompt composition", () => {
		expect(WORKFLOW_RULE).toContain("choosing-a-workflow");
		expect(WORKFLOW_RULE).toContain("Continue work already routed");
	});

	test("classifies every GitHub merge state before declaring a PR ready", () => {
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		for (const state of [
			"UNKNOWN",
			"BEHIND",
			"DIRTY",
			"UNSTABLE",
			"BLOCKED",
			"CLEAN",
			"HAS_HOOKS",
		]) {
			expect(checks).toContain(`\`${state}\``);
		}
		expect(checks).toContain("isDraft");
		expect(checks).toContain("reviewDecision");
		expect(checks).not.toContain("Any other computed state");
	});

	test("creates PRs without duplicate verification or unsolicited monitoring", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Create a PR — the work is finished | `creating.md` | snapshot");
		expect(skill).toContain("A push never upgrades the mode by");
		expect(creating).toContain("Do not rerun a passing command merely because PR creation");
		expect(creating).toContain("defaults to snapshot mode");
	});

	test("ties reused verification and empty check rollups to observed final state", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		const comments = readFileSync(
			new URL("./skills/shipping-a-pr/review-comments.md", import.meta.url),
			"utf8",
		);
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Before every code-affecting push");
		expect(creating).toContain("repeat gates 3–5 against the new head");
		expect(comments).toContain("final-tree verification rule");
		expect(checks).toContain("no checks currently reported");
		expect(checks).toContain("Never infer “no checks configured” from one empty rollup");
	});

	test("reapplies title edits after a concurrent GitHub change", () => {
		const body = readFileSync(new URL("./skills/shipping-a-pr/body.md", import.meta.url), "utf8");
		expect(body).toContain("immediately re-fetch the current title");
		expect(body).toContain("reapply");
		expect(body).toContain("requested mutation to that fresh title");
	});
});

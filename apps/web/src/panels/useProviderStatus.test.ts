import { expect, test } from "bun:test";
import { reportHasModelSource } from "./useProviderStatus";

test("only a configured SDK endpoint counts as a model source", () => {
	expect(
		reportHasModelSource({ providers: [{ id: "custom-go", name: "Go", configured: true }] }),
	).toBe(true);
	expect(
		reportHasModelSource({ providers: [{ id: "custom-go", name: "Go", configured: false }] }),
	).toBe(false);
	expect(reportHasModelSource({ providers: [] })).toBe(false);
});

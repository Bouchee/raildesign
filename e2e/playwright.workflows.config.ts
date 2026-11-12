import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./workflows",
	testMatch: "harness.unit.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 30000,
	reporter: "list",
	outputDir: "../test-results/workflow-helpers",
});

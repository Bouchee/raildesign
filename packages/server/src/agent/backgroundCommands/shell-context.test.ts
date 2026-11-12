import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellEnvironment } from "./shell-context";

test("command environments exclude model keys, secrets and stale session markers", () => {
	const root = mkdtempSync(join(tmpdir(), "raildesign-background-env-"));
	const names = [
		"THINKRAIL_DATA_DIR",
		"BG_PRIVATE_VALUE",
		"BACKGROUND_API_KEY",
		"PI_SESSION_ID",
		"RAILDESIGN_SESSION_ID",
	] as const;
	const previous = names.map((name) => process.env[name]);
	try {
		process.env.THINKRAIL_DATA_DIR = root;
		process.env.BG_PRIVATE_VALUE = "model-key-sentinel";
		process.env.BACKGROUND_API_KEY = "secret-sentinel";
		process.env.PI_SESSION_ID = "old-pi-session";
		process.env.RAILDESIGN_SESSION_ID = "old-session";
		writeFileSync(
			join(root, "models.json"),
			JSON.stringify({
				version: 1,
				endpoints: [
					{
						id: "custom-test",
						name: "Test",
						baseUrl: "https://example.invalid/v1",
						apiKey: "$BG_PRIVATE_VALUE",
						models: [
							{
								id: "test",
								contextWindow: null,
								maxTokens: null,
								reasoning: null,
								vision: null,
								tools: null,
							},
						],
					},
				],
			}),
		);
		const environment = shellEnvironment("current", { cwd: root });
		expect(environment.BG_PRIVATE_VALUE).toBeUndefined();
		expect(environment.BACKGROUND_API_KEY).toBeUndefined();
		expect(environment.PI_SESSION_ID).toBeUndefined();
		expect(environment.RAILDESIGN_SESSION_ID).toBe("current");
		expect(
			shellEnvironment("hidden", { cwd: root, exposeSessionEnvironment: false })
				.RAILDESIGN_SESSION_ID,
		).toBeUndefined();
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		rmSync(root, { recursive: true, force: true });
	}
});

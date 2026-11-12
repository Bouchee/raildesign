import { chmodSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { removeTree } from "@thinkrail/shared/removeTree";
import { E2E_BASE_CONFIG } from "./fixtures/appConfig";
import { writeFakeGh, writeHermeticE2eShell } from "./fixtures/executables";
import {
	E2E_DATA_DIR,
	E2E_FAKE_BIN_DIR,
	E2E_FIXTURE_REPO,
	E2E_GH_LOG,
	E2E_GH_SCENARIO,
	E2E_HOME_DIR,
	E2E_INSTALLED_FONTS,
	E2E_PICK_DIR_POINTER,
} from "./fixtures/paths";
import { seedFixtureRepo } from "./fixtures/repo";
import {
	isLiveAgentE2e,
	seedAgentConfiguration,
	seedE2eDefaultModel,
	waitForAgentTarget,
} from "./fixtures/sdkAgent";
import { seedExternalCwdSessions } from "./fixtures/sessions";
import { seedSpeechFixture } from "./fixtures/speech";
import { seedTemplateFixtures } from "./fixtures/templates";
import { E2eWire } from "./fixtures/wire";

export default async function globalSetup(config?: FullConfig): Promise<void> {
	mkdirSync(E2E_DATA_DIR, { recursive: true });
	// Playwright starts the host and its writer lock before global setup.
	for (const name of readdirSync(E2E_DATA_DIR)) {
		if (name !== "host.lock") removeTree(join(E2E_DATA_DIR, name));
	}
	writeFileSync(join(E2E_DATA_DIR, "config.json"), JSON.stringify(E2E_BASE_CONFIG));
	mkdirSync(E2E_HOME_DIR, { recursive: true });
	for (const rc of [".zshrc", ".bashrc"]) writeFileSync(join(E2E_HOME_DIR, rc), "");
	mkdirSync(E2E_FAKE_BIN_DIR, { recursive: true });
	for (const command of ["code", "github-ssh"]) {
		const target = join(E2E_FAKE_BIN_DIR, command);
		copyFileSync(new URL(`./fixtures/bin/${command}`, import.meta.url), target);
		chmodSync(target, 0o755);
	}
	writeHermeticE2eShell(E2E_FAKE_BIN_DIR, process.env.SHELL ?? "/bin/bash");
	writeFakeGh(E2E_FAKE_BIN_DIR, E2E_GH_SCENARIO, E2E_GH_LOG);
	seedAgentConfiguration();
	seedExternalCwdSessions();
	seedTemplateFixtures();
	seedFixtureRepo();
	writeFileSync(E2E_PICK_DIR_POINTER, E2E_FIXTURE_REPO);
	writeFileSync(E2E_INSTALLED_FONTS, "[]");
	seedSpeechFixture();
	const baseURL = config?.projects[0]?.use.baseURL;
	if (!baseURL) return;
	const wire = await E2eWire.connect(Number(new URL(baseURL).port));
	try {
		if (isLiveAgentE2e()) await waitForAgentTarget(wire);
		else await seedE2eDefaultModel(wire);
		await wire.request("settings.update", { config: { onboardingDismissed: true } });
	} finally {
		wire.close();
	}
}

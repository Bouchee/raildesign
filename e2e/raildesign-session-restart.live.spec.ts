import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { hermeticE2ePath, hermeticE2eShell, resolveBunExecutable } from "./fixtures/executables";
import {
	E2E_FAKE_BIN_DIR,
	E2E_FIXTURE_REPO,
	E2E_RESTART_DATA_DIR,
	E2E_RESTART_HOST_LOG,
	E2E_RESTART_PORT,
} from "./fixtures/paths";
import { seedAgentConfiguration, seedE2eDefaultModel } from "./fixtures/sdkAgent";
import { E2eWire, E2eWireTransientError } from "./fixtures/wire";

test(
	"host restart restores approval and queue without repeating a completed effect",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
		mkdirSync(join(E2E_RESTART_DATA_DIR, "home"), { recursive: true });
		seedAgentConfiguration(E2E_RESTART_DATA_DIR);
		const origin = `http://localhost:${E2E_RESTART_PORT}`;
		const lock = join(E2E_RESTART_DATA_DIR, "host.lock");
		const startHost = () => {
			const log = openSync(E2E_RESTART_HOST_LOG, "a", 0o600);
			try {
				return spawn(resolveBunExecutable(), ["packages/server/src/dev.ts"], {
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					env: {
						...process.env,
						...toolHomeEnv(join(E2E_RESTART_DATA_DIR, "home")),
						THINKRAIL_PORT: String(E2E_RESTART_PORT),
						THINKRAIL_DATA_DIR: E2E_RESTART_DATA_DIR,
						THINKRAIL_STATIC_DIR: fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
						THINKRAIL_GH_OFFLINE: "1",
						PATH: hermeticE2ePath(E2E_FAKE_BIN_DIR),
						SHELL: hermeticE2eShell(E2E_FAKE_BIN_DIR),
						DISPLAY: "",
						WAYLAND_DISPLAY: "",
						CI: "1",
					},
					stdio: ["ignore", log, log],
				});
			} finally {
				closeSync(log);
			}
		};
		let host = startHost();
		let wire: E2eWire | undefined;
		const waitForHost = async () => {
			await expect
				.poll(
					async () => {
						if (host.exitCode !== null || host.signalCode !== null)
							throw new Error("The isolated restart host exited before readiness");
						return fetch(`${origin}/health`)
							.then((response) => response.status)
							.catch(() => 0);
					},
					{ timeout: 30_000 },
				)
				.toBe(200);
		};
		const crash = async () => {
			host.kill("SIGKILL");
			await once(host, "exit");
			await expect
				.poll(() => (existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : 11_000), {
					timeout: 20_000,
				})
				.toBeGreaterThan(10_000);
		};
		try {
			await waitForHost();
			wire = await E2eWire.connect(E2E_RESTART_PORT);
			await seedE2eDefaultModel(wire);
			const project = await wire.request("project.open", { path: E2E_FIXTURE_REPO });
			const workspace = await wire.request("workspace.create", { projectId: project.id }, 30_000);
			const { sessionId } = await wire.request("session.create", { workspaceId: workspace.id });
			const command = "printf 'RESTART_EFFECT\\n' >> restart-effect.marker";
			const prompt = wire
				.request(
					"session.prompt",
					{
						sessionId,
						messageId: "restart-initial",
						text: `Use bash exactly once, timeoutMs 10000, command exactly: ${command}. Use no other tool. Then reply RESTART_DONE.`,
					},
					120_000,
				)
				.catch((error: unknown) => error);
			const initialWire = wire;
			await expect
				.poll(
					async () =>
						(
							await initialWire.request("session.getMessages", {
								sessionId,
								workspaceId: workspace.id,
							})
						).summary.state?.needsInput?.kind,
					{ timeout: 60_000 },
				)
				.toBe("dialog");
			await wire.request("session.followUp", {
				sessionId,
				messageId: "restart-followup",
				text: "Reply only RESTART_FOLLOWUP. Use no tools.",
			});
			const waiting = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			const pending = waiting.summary.state?.needsInput;
			if (pending?.kind !== "dialog" || pending.request.kind !== "confirm")
				throw new Error("No pending tool approval before restart");
			const { runId, revision, toolCallId } = pending.request;
			if (!runId || revision === undefined || !toolCallId)
				throw new Error("The saved tool approval has incomplete ownership");
			expect(pending.request.toolInput?.command).toBe(command);
			wire.close();
			await expect(prompt).resolves.toBeInstanceOf(E2eWireTransientError);
			await crash();
			host = startHost();
			await waitForHost();
			wire = await E2eWire.connect(E2E_RESTART_PORT);
			const recovered = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			expect(recovered.messages).toEqual(waiting.messages);
			expect(recovered.summary.state?.needsInput).toEqual(pending);
			expect(recovered.summary.queue).toEqual(waiting.summary.queue);
			await page.goto(origin);
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			const response = {
				sessionId,
				id: pending.interactionId,
				runId,
				revision,
				toolCallId,
				value: true,
			};
			await wire.request("session.extUiReply", { response });
			const resumedWire = wire;
			await expect
				.poll(
					async () => {
						const snapshot = await resumedWire.request("session.getMessages", {
							sessionId,
							workspaceId: workspace.id,
						});
						return (
							snapshot.summary.state?.completion?.outcome === "succeeded" &&
							snapshot.messages.some(
								(message) =>
									message.role === "assistant" &&
									JSON.stringify(message.content).includes("RESTART_FOLLOWUP"),
							)
						);
					},
					{ timeout: 120_000 },
				)
				.toBe(true);
			expect(readFileSync(join(workspace.worktreePath, "restart-effect.marker"), "utf8")).toBe(
				"RESTART_EFFECT\n",
			);
			const finished = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			wire.close();
			await crash();
			host = startHost();
			await waitForHost();
			wire = await E2eWire.connect(E2E_RESTART_PORT);
			await wire.request("session.extUiReply", { response });
			const restored = await wire.request("session.getMessages", {
				sessionId,
				workspaceId: workspace.id,
			});
			expect(restored.messages).toEqual(finished.messages);
			expect(restored.messages.filter((message) => message.id === "restart-followup")).toHaveLength(
				1,
			);
			expect(readFileSync(join(workspace.worktreePath, "restart-effect.marker"), "utf8")).toBe(
				"RESTART_EFFECT\n",
			);
			await testInfo.attach("restart-proof", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ sessionId, recovered, restored }, null, 2)),
			});
		} finally {
			wire?.close();
			if (host.exitCode === null && host.signalCode === null) {
				host.kill("SIGTERM");
				try {
					await expect
						.poll(() => host.exitCode !== null || host.signalCode !== null, { timeout: 15_000 })
						.toBe(true);
				} finally {
					if (host.exitCode === null && host.signalCode === null) {
						host.kill("SIGKILL");
						await once(host, "exit");
					}
				}
			}
			rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
		}
	},
);

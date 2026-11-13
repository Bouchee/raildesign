import { setTimeout } from "node:timers/promises";
import { expect, type Page } from "@playwright/test";
import type { WsResult } from "@thinkrail/contracts";
import { openAppFresh } from "../../fixtures/app";
import { seedE2eDefaultModel } from "../../fixtures/sdkAgent";
import type { E2eWire } from "../../fixtures/wire";
import { skipAll } from "./dialog";
import { type CapturedToolCall, EventLog } from "./events";
import type { Signal } from "./signals";
import { checkBudget, DEFAULT_BUDGET } from "./watchdog";
import { seedWorkspace, type WorkspaceSeed } from "./workspace";

export interface WorkflowSession {
	workspaceId: string;
	sessionId: string;
	cwd: string;
}

export interface TurnOptions {
	stopWhen?: Signal[];
	forbid?: Signal[];
	answer?: (call: CapturedToolCall) => unknown;
	allowConfirm?: (call: CapturedToolCall) => boolean | undefined;
}

export async function openSeededSession(
	page: Page,
	wire: Pick<E2eWire, "request">,
	seed: WorkspaceSeed,
): Promise<WorkflowSession> {
	await openAppFresh(page);
	const project = await wire.request("project.open", { path: seedWorkspace(seed) });
	const cwd = project.path;
	await wire.request("project.setTrust", { id: project.id, trusted: true, resources: true });
	await seedE2eDefaultModel(wire);
	const workspaces = await wire.request("workspace.list", { projectId: project.id });
	const workspace = workspaces.find((item) => item.kind === "default");
	if (!workspace || workspace.worktreePath !== cwd)
		throw new Error("The seeded project has no default workspace at its source path");
	const { sessionId } = await wire.request("session.create", { workspaceId: workspace.id });
	return { workspaceId: workspace.id, sessionId, cwd };
}

export async function driveTurn(
	wire: Pick<E2eWire, "request">,
	ids: Pick<WorkflowSession, "workspaceId" | "sessionId">,
	prompt: string,
	options: TurnOptions = {},
) {
	const startedAt = Date.now();
	const answered = new Set<string>();
	let failure: string | null = null;
	let stoppedBy: string | null = null;
	let snapshot: WsResult<"session.getMessages"> = await wire.request("session.getMessages", ids);
	const previousMessages = snapshot.messages.length;
	const previousCompletionId = snapshot.summary.state?.completion?.completionId;
	let admitted = false;
	let promptFailure: string | null = null;
	let promptRequest = Promise.resolve();
	try {
		promptRequest = wire
			.request("session.prompt", { sessionId: ids.sessionId, text: prompt }, DEFAULT_BUDGET.maxMs)
			.then(
				() => {},
				(error: unknown) => {
					promptFailure = error instanceof Error ? error.message : String(error);
				},
			);
		for (;;) {
			snapshot = await wire.request("session.getMessages", ids);
			const log = EventLog.fromMessages(snapshot.messages.slice(previousMessages));
			const forbidden = options.forbid?.find((signal) => signal.test(log));
			failure =
				forbidden?.description ?? promptFailure ?? checkBudget(log, startedAt, DEFAULT_BUDGET);
			if (failure) break;
			const stop = options.stopWhen?.find((signal) => signal.test(log));
			if (stop) {
				stoppedBy = stop.description;
				break;
			}
			const pending = snapshot.summary.state?.needsInput;
			if (pending && !answered.has(pending.interactionId)) {
				if (pending.kind === "tool-response") {
					const call = log.toolCalls().find((item) => item.toolCallId === pending.toolCallId);
					if (call?.toolName !== "ask_user_question") {
						failure = "Unexpected tool-response interaction";
						break;
					}
					answered.add(pending.interactionId);
					await wire.request("session.respondToTool", {
						sessionId: ids.sessionId,
						toolCallId: pending.toolCallId,
						runId: pending.runId,
						interactionId: pending.interactionId,
						revision: pending.revision,
						response: options.answer ? options.answer(call) : skipAll(),
					});
				} else {
					const request = pending.request;
					if (
						request.kind !== "confirm" ||
						!request.runId ||
						!request.toolCallId ||
						request.revision === undefined
					) {
						failure = "Unexpected approval interaction";
						break;
					}
					const call = log.toolCalls().find((item) => item.toolCallId === request.toolCallId);
					const allowed = call && options.allowConfirm ? options.allowConfirm(call) : false;
					if (allowed !== undefined) {
						answered.add(pending.interactionId);
						await wire.request("session.extUiReply", {
							response: {
								id: request.id,
								sessionId: ids.sessionId,
								runId: request.runId,
								toolCallId: request.toolCallId,
								revision: request.revision,
								value: allowed,
							},
						});
						if (!allowed) {
							failure = `Forbidden approval: ${call?.toolName ?? request.title}`;
							break;
						}
					}
				}
			}
			const state = snapshot.summary.state;
			admitted ||=
				snapshot.messages.length > previousMessages ||
				state?.execution === "running" ||
				!!state?.needsInput ||
				(!!state?.completion && state.completion.completionId !== previousCompletionId);
			if (admitted && state?.execution === "idle" && !state.needsInput && !state.backgroundWork) {
				if (state.completion?.outcome !== "succeeded")
					failure = `Turn settled with ${state.completion?.outcome ?? "no completion"}`;
				else if (options.stopWhen?.length) failure = "Turn completed without its stop signal";
				break;
			}
			await setTimeout(100);
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		try {
			await wire.request("session.abort", { sessionId: ids.sessionId });
			await expect
				.poll(
					async () => {
						snapshot = await wire.request("session.getMessages", ids);
						const state = snapshot.summary.state;
						return state?.execution === "idle" && !state.needsInput && !state.backgroundWork;
					},
					{ timeout: 10_000, intervals: [100] },
				)
				.toBe(true);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failure = `${failure ? `${failure}; ` : ""}Failed to settle after abort: ${detail}`;
		}
		await promptRequest;
	}
	const log = EventLog.fromMessages(snapshot.messages.slice(previousMessages));
	failure ??= options.forbid?.find((signal) => signal.test(log))?.description ?? promptFailure;
	return {
		snapshot,
		log,
		failure,
		stoppedBy,
		answered: [...answered],
		elapsedMs: Date.now() - startedAt,
	};
}

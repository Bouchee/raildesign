import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ReviewFailedPayload } from "@thinkrail/contracts";
import { PROTOCOL_VERSION, WS_CHANNELS } from "@thinkrail/contracts";
import { TodoStore } from "@thinkrail/todos/core";
import {
	abortSession,
	configureAgentModelFactory,
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	promptSession,
	readSessionRecord,
	renameSession,
	setRequestReviewHandler,
	setResolveCommentHandler,
} from "../agent";
import { loadConfig, saveConfig, saveProjects, saveWorkspaces } from "../persistence";
import { getReviewSnapshot } from "../reviews";
import { resetConfigCache } from "../settings";
import { readReviewMeta, todoReviewAutoCycles, todoReviewRecord } from "../todos";
import { handleRequest } from "./handlers";
import { itemReviewActive } from "./planReviewQueue";
import {
	installRequestReviewSeam,
	setReviewFailedPublisher,
	startPlanReview,
} from "./requestReview";
import { withReviewLock } from "./reviewLock";
import { createServer } from "./server";

const previous = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
	OPENAI_MODEL: process.env.OPENAI_MODEL,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	HOME: process.env.HOME,
};
let root: string;
let cwd: string;
let sessionId: string;
let itemId: string;
let sha: string;
const failures: ReviewFailedPayload[] = [];
function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (!result.success) throw new Error(`Fixture git command failed: ${args[0]}`);
	return result.stdout.toString().trim();
}
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sdk-plan-review-"));
	cwd = join(root, "repo");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.HOME = join(root, "home");
	mkdirSync(process.env.HOME);
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "offline-review-key";
	git("init", "-b", "main");
	git("config", "user.email", "fixture@example.test");
	git("config", "user.name", "Fixture");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, "a.ts"), "export const count = 1;\n");
	git("add", "a.ts");
	git("commit", "-m", "initial");
	writeFileSync(join(cwd, "a.ts"), "export const count = 2;\n");
	git("add", "a.ts");
	git("commit", "-m", "change count");
	sha = git("rev-parse", "HEAD");
	saveProjects([{ id: "project", name: "Fixture", path: cwd, slug: "fixture", lastOpened: 1 }]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Fixture",
			renamed: true,
			branch: "main",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	saveConfig({
		...loadConfig(),
		agentReviewEnabled: true,
		reviewAutoFix: false,
		defaultEffort: "off",
		reviewEffort: "off",
	});
	resetConfigCache();
	({ sessionId } = await createSession({ workspaceId: "workspace", cwd }));
	const store = new TodoStore(cwd, sessionId);
	const item = store.add({ title: "Change the count", artifacts: [{ kind: "commit", sha }] });
	store.update(item.id, { status: "done" });
	itemId = item.id;
	failures.length = 0;
	setReviewFailedPublisher((failure) => failures.push(failure));
	installRequestReviewSeam();
});
afterEach(() => {
	disposeAllSessions();
	configureAgentModelFactory();
	setRequestReviewHandler(undefined);
	setResolveCommentHandler(undefined);
	setReviewFailedPublisher(() => {});
	resetConfigCache();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
async function waitReview() {
	for (
		let attempt = 0;
		attempt < 300 &&
		(itemReviewActive(sessionId, itemId) ||
			getSessionState(sessionId).backgroundWork ||
			getSessionState(sessionId).execution === "running");
		attempt++
	)
		await Bun.sleep(10);
	expect(itemReviewActive(sessionId, itemId)).toBe(false);
}
const ref = () => ({ workspaceId: "workspace", sessionId, id: itemId });
const verdict = (changes: boolean) =>
	JSON.stringify({
		verdict: changes ? "request_changes" : "approve",
		summary: changes ? "Incorrect count" : "The change is correct",
		readingOrder: [{ path: "a.ts", why: "Start with the changed value" }],
		findings: changes
			? [{ id: "f1", path: "a.ts", startLine: 1, body: "BUG: Correct the requested count." }]
			: [],
	});
function reviewer(text: string) {
	return new ScriptedModel([
		modelResponse([functionCall("read", { path: "a.ts" }, { callId: "review-read" })]),
		modelResponse([assistantMessage(text)]),
	]);
}

test("an actual SDK review child reads the change set and persists canonical findings and its guide", async () => {
	const model = reviewer(verdict(true));
	configureAgentModelFactory(() => model);
	expect(startPlanReview("workspace", sessionId, itemId)).toBe(true);
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeDefined();
	await waitReview();
	expect(todoReviewRecord(ref())?.state).toBe("changes_requested");
	const snapshot = await getReviewSnapshot("workspace");
	expect(snapshot.comments).toHaveLength(1);
	expect(snapshot.comments[0]?.id).toMatch(/^rc_/);
	expect(snapshot.comments[0]?.origin).toEqual({ sessionId, todoId: itemId, reviewedSha: sha });
	expect(snapshot.review.guide?.readingOrder[0]?.path).toBe("a.ts");
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
	expect(JSON.stringify(model.calls[0]?.request.input)).toContain("export const count = 1");
	expect(JSON.stringify(model.calls[0]?.request.input)).toContain("export const count = 2");
	const names = model.calls[0]?.request.tools.map((tool) => ("name" in tool ? tool.name : ""));
	expect(names).toContain("read");
	expect(names).not.toContain("bash");
	expect(names).not.toContain("request_review");
	expect(failures).toEqual([]);
});

test("host boot wires SDK review tools, button routes, failure publication and fix delivery", async () => {
	setRequestReviewHandler(undefined);
	setResolveCommentHandler(undefined);
	const server = await createServer({ port: 0, host: "127.0.0.1" });
	const socket = new WebSocket(
		`ws://127.0.0.1:${server.port}/ws?client=review-smoke&protocol=${PROTOCOL_VERSION}`,
	);
	const published: ReviewFailedPayload[] = [];
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data));
		if (frame.channel === WS_CHANNELS.reviewFailed) published.push(frame.data);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("Local review socket failed")), {
				once: true,
			});
		});
		const manual = join(root, "data", "skills", "manual");
		mkdirSync(manual, { recursive: true });
		writeFileSync(
			join(manual, "SKILL.md"),
			"---\nname: manual\ndescription: Manual procedure\ndisable-model-invocation: true\n---\nFollow manual instructions.",
		);
		expect(
			await handleRequest("session.getCommands", { sessionId }, { clientKey: "review-smoke" }),
		).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "skill:manual", source: "skill" })]),
		);
		await expect(
			handleRequest("session.getCommands", { sessionId: "missing" }, { clientKey: "review-smoke" }),
		).rejects.toThrow("Unknown session");
		const parent = new ScriptedModel([
			modelResponse([functionCall("request_review", { itemId }, { callId: "boot-review" })]),
			modelResponse([assistantMessage("review received")]),
		]);
		configureAgentModelFactory((_model, id) =>
			id === sessionId ? parent : reviewer(verdict(false)),
		);
		expect(
			await handleRequest("session.reloadResources", { sessionId }, { clientKey: "review-smoke" }),
		).toEqual({ ok: true });
		expect(parent.calls).toHaveLength(0);
		await handleRequest(
			"session.prompt",
			{ sessionId, text: "Review this completed step" },
			{ clientKey: "review-smoke" },
		);
		expect(todoReviewRecord(ref())?.state).toBe("reviewed");
		parent.assertComplete();
		const extraStore = new TodoStore(cwd, sessionId);
		const extra = extraStore.add({
			title: "Review the same delta independently",
			artifacts: [{ kind: "commit", sha }],
		});
		extraStore.update(extra.id, { status: "done" });
		expect(
			await handleRequest(
				"todo.reviewAll",
				{ workspaceId: "workspace", sessionId },
				{ clientKey: "review-smoke" },
			),
		).toEqual({ ok: true, total: 1 });
		for (let attempt = 0; attempt < 300 && itemReviewActive(sessionId, extra.id); attempt++)
			await Bun.sleep(10);
		expect(todoReviewRecord({ ...ref(), id: extra.id })?.state).toBe("reviewed");
		await expect(
			handleRequest(
				"todo.startReview",
				{ ...ref(), workspaceId: "foreign" },
				{ clientKey: "review-smoke" },
			),
		).rejects.toThrow("another workspace");
		configureAgentModelFactory(() => reviewer("invalid verdict"));
		await handleRequest("todo.startReview", ref(), { clientKey: "review-smoke" });
		await handleRequest("todo.startReview", ref(), { clientKey: "review-smoke" });
		await waitReview();
		for (let attempt = 0; attempt < 100 && published.length === 0; attempt++) await Bun.sleep(10);
		expect(published).toHaveLength(1);
		expect(published[0]).toMatchObject({ sessionId, itemId });
		expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
		expect(
			await handleRequest(
				"todo.reviewAll",
				{ workspaceId: "workspace", sessionId },
				{ clientKey: "review-smoke" },
			),
		).toEqual({ ok: true, total: 0 });
		const fixed = new ScriptedModel([modelResponse([assistantMessage("fix complete")])]);
		configureAgentModelFactory(() => fixed);
		expect(
			await handleRequest(
				"todo.requestFix",
				{ ...ref(), feedback: "Confirm the count" },
				{ clientKey: "review-smoke" },
			),
		).toEqual({ ok: true });
		expect(JSON.stringify(fixed.calls[0]?.request.input)).toContain("Confirm the count");
		fixed.assertComplete();
		for (const [callId, title] of [
			["sdk-title", "SDK proposed title"],
			["protected-title", "Replacement"],
		] as const) {
			if (callId === "protected-title")
				await renameSession(sessionId, "workspace", cwd, "Manual title");
			const titleModel = new ScriptedModel([
				modelResponse([functionCall("set_title", { chat_title: title }, { callId })]),
				modelResponse([assistantMessage("named")]),
			]);
			configureAgentModelFactory(() => titleModel);
			await promptSession(sessionId, "Name this chat");
			expect(readSessionRecord(sessionId)?.title).toBe(
				callId === "sdk-title" ? title : "Manual title",
			);
			expect(readSessionRecord(sessionId)?.effects[callId]).toMatchObject({
				status: "completed",
				isError: false,
			});
			titleModel.assertComplete();
		}
	} finally {
		socket.close();
		await server.shutdown();
	}
});

test("invalid SDK review output clears its pending mark and claim and allows a retry", async () => {
	configureAgentModelFactory(() => reviewer("Invalid review output"));
	startPlanReview("workspace", sessionId, itemId);
	await waitReview();
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
	expect(todoReviewRecord(ref())).toBeUndefined();
	expect(failures).toHaveLength(1);
	configureAgentModelFactory(() => reviewer(verdict(false)));
	expect(startPlanReview("workspace", sessionId, itemId)).toBe(true);
	await waitReview();
	expect(todoReviewRecord(ref())?.state).toBe("reviewed");
});

test("request_review delivers canonical finding IDs and a later resolve permits approval", async () => {
	saveConfig({ ...loadConfig(), reviewAutoFix: true });
	resetConfigCache();
	let changes = true;
	let parent = new ScriptedModel([
		modelResponse([functionCall("request_review", { itemId }, { callId: "review" })]),
		modelResponse([assistantMessage("received review")]),
	]);
	configureAgentModelFactory((_model, id) =>
		id === sessionId ? parent : reviewer(verdict(changes)),
	);
	await promptSession(sessionId, "Review this completed step.");
	const snapshot = await getReviewSnapshot("workspace");
	const finding = snapshot.comments[0];
	if (!finding) throw new Error("Missing canonical finding");
	expect(finding.status).toBe("sent");
	expect(todoReviewAutoCycles(ref())).toBe(1);
	expect(
		JSON.stringify((await getSessionMessages(sessionId, "workspace", cwd)).messages),
	).toContain(finding.id);
	changes = false;
	parent = new ScriptedModel([
		modelResponse([
			functionCall(
				"resolve_comment",
				{ commentId: finding.id, note: "Corrected the count" },
				{ callId: "resolve" },
			),
		]),
		modelResponse([functionCall("request_review", { itemId }, { callId: "recheck" })]),
		modelResponse([assistantMessage("review complete")]),
	]);
	await promptSession(sessionId, "Resolve the corrected finding and review again.");
	expect(todoReviewRecord(ref())?.state).toBe("reviewed");
	expect((await getReviewSnapshot("workspace")).comments[0]?.status).toBe("resolved");
});

test("Stop cancels the SDK review child and clears pending review state", async () => {
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	configureAgentModelFactory(
		() =>
			new ScriptedModel([
				modelResponder(async ({ request }) => {
					ready();
					if (!request.signal) throw new Error("Missing review cancellation signal");
					await new Promise<void>((_resolve, reject) =>
						request.signal?.addEventListener("abort", () => reject(new Error("Review aborted")), {
							once: true,
						}),
					);
					return [assistantMessage(verdict(false))];
				}),
			]),
	);
	startPlanReview("workspace", sessionId, itemId);
	await started;
	await abortSession(sessionId);
	await waitReview();
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
	expect(todoReviewRecord(ref())).toBeUndefined();
	expect(failures).toHaveLength(1);
});

test("Stop cancels queued reviews before another SDK child is admitted", async () => {
	const store = new TodoStore(cwd, sessionId);
	const second = store.add({ title: "Queued review", artifacts: [{ kind: "commit", sha }] });
	store.update(second.id, { status: "done" });
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let children = 0;
	configureAgentModelFactory(() => {
		children++;
		return new ScriptedModel([
			modelResponder(async ({ request }) => {
				ready();
				if (!request.signal) throw new Error("Missing review cancellation signal");
				await new Promise<void>((_resolve, reject) =>
					request.signal?.addEventListener("abort", () => reject(new Error("Review aborted")), {
						once: true,
					}),
				);
				return [assistantMessage(verdict(false))];
			}),
		]);
	});
	startPlanReview("workspace", sessionId, itemId);
	await started;
	expect(startPlanReview("workspace", sessionId, second.id)).toBe(true);
	await abortSession(sessionId);
	await waitReview();
	expect(children).toBe(1);
	expect(itemReviewActive(sessionId, second.id)).toBe(false);
	expect(readReviewMeta(cwd, sessionId).pending).toEqual({});
	expect(failures).toHaveLength(2);
});

test("a failed SDK fix run restores draft findings and terminates the automatic cycle", async () => {
	saveConfig({ ...loadConfig(), reviewAutoFix: true });
	resetConfigCache();
	configureAgentModelFactory((_model, id) =>
		id === sessionId
			? new ScriptedModel([
					modelResponder(() => {
						throw new Error("Fixture worker failure");
					}),
				])
			: reviewer(verdict(true)),
	);
	expect(startPlanReview("workspace", sessionId, itemId)).toBe(true);
	await waitReview();
	expect(todoReviewRecord(ref())?.state).toBe("changes_requested");
	expect(todoReviewAutoCycles(ref())).toBe(2);
	expect((await getReviewSnapshot("workspace")).comments[0]?.status).toBe("draft");
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
});

test("Stop prevents delayed verdict filing after the SDK child completes", async () => {
	let unlock: () => void = () => {};
	let held: () => void = () => {};
	const locked = new Promise<void>((resolve) => {
		held = resolve;
	});
	const lock = withReviewLock("workspace", async () => {
		held();
		await new Promise<void>((resolve) => {
			unlock = resolve;
		});
	});
	await locked;
	let ready: () => void = () => {};
	const completed = new Promise<void>((resolve) => {
		ready = resolve;
	});
	configureAgentModelFactory(
		() =>
			new ScriptedModel([
				modelResponder(() => {
					ready();
					return [assistantMessage(verdict(true))];
				}),
			]),
	);
	startPlanReview("workspace", sessionId, itemId);
	await completed;
	await Bun.sleep(20);
	const stopping = abortSession(sessionId);
	unlock();
	await lock;
	await stopping;
	expect(readReviewMeta(cwd, sessionId).pending[itemId]).toBeUndefined();
	expect(todoReviewRecord(ref())).toBeUndefined();
	expect((await getReviewSnapshot("workspace")).comments).toEqual([]);
	expect(itemReviewActive(sessionId, itemId)).toBe(false);
});

test("an approval cannot settle a step with open canonical findings", async () => {
	configureAgentModelFactory(() => reviewer(verdict(true)));
	startPlanReview("workspace", sessionId, itemId);
	await waitReview();
	configureAgentModelFactory(() => reviewer(verdict(false)));
	startPlanReview("workspace", sessionId, itemId);
	await waitReview();
	expect(todoReviewRecord(ref())?.state).toBe("changes_requested");
	expect((await getReviewSnapshot("workspace")).comments[0]?.status).toBe("draft");
	expect((await getReviewSnapshot("workspace")).review.guide?.verdict).toBe("request_changes");
});

for (const laterFailure of [false, true]) {
	test(`automatic fix can resolve findings and request re-review before settling${laterFailure ? " without a later failure replacing approval" : ""}`, async () => {
		saveConfig({ ...loadConfig(), reviewAutoFix: true });
		resetConfigCache();
		let reviews = 0;
		const worker = new ScriptedModel([
			modelResponder(async () => {
				expect(itemReviewActive(sessionId, itemId)).toBe(false);
				const comment = (await getReviewSnapshot("workspace")).comments[0];
				if (!comment) throw new Error("Missing canonical finding");
				writeFileSync(join(cwd, "a.ts"), "export const count = 3;\n");
				git("add", "a.ts");
				git("commit", "-m", "fix count");
				return [
					functionCall(
						"resolve_comment",
						{ commentId: comment.id, note: "Fixed count" },
						{ callId: "resolve-auto" },
					),
				];
			}),
			modelResponse([
				functionCall("todo_update", { id: itemId, status: "done" }, { callId: "complete-auto" }),
			]),
			modelResponse([functionCall("request_review", { itemId }, { callId: "rereview-auto" })]),
			modelResponder(() => {
				if (laterFailure) throw new Error("Fixture failure after approved re-review");
				return [assistantMessage("fix reviewed")];
			}),
		]);
		configureAgentModelFactory((_model, id) =>
			id === sessionId ? worker : reviewer(verdict(reviews++ === 0)),
		);
		expect(startPlanReview("workspace", sessionId, itemId)).toBe(true);
		await waitReview();
		expect(reviews).toBe(2);
		expect(todoReviewRecord(ref())?.state).toBe("reviewed");
		expect((await getReviewSnapshot("workspace")).comments[0]?.status).toBe("resolved");
		expect(readSessionRecord(sessionId)?.effects["rereview-auto"]).toMatchObject({
			status: "completed",
			isError: false,
		});
		expect(failures).toEqual([]);
		worker.assertComplete();
	});
}

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Usage } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest } from "@thinkrail/contracts";
import { isDelegationRunDetails } from "@thinkrail/contracts";
import { TodoStore } from "@thinkrail/todos/core";
import { loadConfig, loadWorkspaces, saveConfig, saveWorkspaces } from "../persistence";
import { archivedCommandOutput, recordResource } from "../resourceHistory";
import * as modelConfiguration from "./modelConfiguration";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	abortSession,
	attachApprovalOwner,
	backgroundCommandOutput,
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	getSessionStats,
	listSessions,
	promptSession,
	removeSession,
	resolveExtUi,
	sessionResourceHistory,
	sessionResources,
	setExtUiPublisher,
	setSessionProjectResolver,
	settleSessionsForShutdown,
	stopBackgroundCommand,
	stopSubagent,
	stopSubagents,
	subagentTranscript,
} from "./sdkSessionManager";
import { listSessionRecords, readSessionRecord } from "./sessionStore";

let directory: string, cwd: string;
const envNames = [
	"THINKRAIL_DATA_DIR",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"OPENAI_API_KEY",
] as const;
let environment: Record<string, string | undefined>;
beforeEach(() => {
	environment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
	directory = mkdtempSync(join(tmpdir(), "raildesign-sdk-execution-"));
	cwd = join(directory, "worktree");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "fixture";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "test",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	saveConfig({
		...loadConfig(),
		disabledExtensions: ["web-access"],
		subagentsEnabled: true,
		subagentMaxConcurrent: 1,
	});
	setSessionProjectResolver(() => "project");
});
afterEach(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	setSessionProjectResolver(() => null);
	for (const name of envNames) {
		if (environment[name] === undefined) delete process.env[name];
		else process.env[name] = environment[name];
	}
	rmSync(directory, { recursive: true, force: true });
});
const done = (text = "done") => modelResponse([assistantMessage(text)]);
const call = (name: string, args: unknown, id: string) =>
	modelResponse([functionCall(name, JSON.stringify(args), { callId: id })]);
const agentCall = (background = false) =>
	call(
		"Agent",
		{
			subagent_type: "worker",
			task: "Read fixture.txt and report.",
			model: null,
			run_in_background: background,
		},
		"child-call",
	);
function approve(request: ExtUiRequest) {
	if (
		request.kind !== "confirm" ||
		!request.runId ||
		request.revision === undefined ||
		!request.toolCallId
	)
		return;
	resolveExtUi({
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		toolCallId: request.toolCallId,
		value: true,
	});
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Expected asynchronous resource state");
		await Bun.sleep(5);
	}
}

test("SDK foreground child returns its report, transcript and owned resource without a visible chat", async () => {
	writeFileSync(join(cwd, "fixture.txt"), "fixture bytes");
	const parent = new ScriptedModel([agentCall(), done("parent complete")]);
	const child = new ScriptedModel([
		call("read", { path: "fixture.txt" }, "child-read"),
		done("CHILD_REPORT"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate the task");
	const record = readSessionRecord(created.sessionId);
	expect(record?.state.completion?.outcome).toBe("succeeded");
	const result = record?.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "Agent",
	);
	expect(result).toMatchObject({ role: "toolResult", details: { status: "completed" } });
	if (result?.role !== "toolResult" || !isDelegationRunDetails(result.details))
		throw new Error("Missing child details");
	expect(result.content).toEqual([{ type: "text", text: "CHILD_REPORT" }]);
	const transcript = await subagentTranscript(
		"workspace",
		created.sessionId,
		result.details.childSessionId,
	);
	expect(transcript.status).toBe("completed");
	expect(
		transcript.messages.some(
			(message) => message.role === "toolResult" && message.toolCallId === "child-read",
		),
	).toBe(true);
	expect((await sessionResources("workspace", created.sessionId)).subagents).toHaveLength(1);
	expect((await listSessions("workspace", cwd)).map((session) => session.sessionId)).toEqual([
		created.sessionId,
	]);
	const other = await createSession({ cwd, workspaceId: "workspace" });
	await expect(
		subagentTranscript("workspace", other.sessionId, result.details.childSessionId),
	).rejects.toThrow("Resource unavailable");
	parent.assertComplete();
	child.assertComplete();
});

test("foreground child approval resumes the SDK child and executes its command once", async () => {
	const parent = new ScriptedModel([agentCall(), done("parent complete")]);
	const child = new ScriptedModel([
		call("bash", { command: "printf child > child.txt", timeoutMs: 1000 }, "child-bash"),
		done("CHILD_WROTE"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	const requests: ExtUiRequest[] = [];
	setExtUiPublisher((request) => {
		requests.push(request);
		approve(request);
	});
	await promptSession(created.sessionId, "Delegate the task");
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
	expect(readFileSync(join(cwd, "child.txt"), "utf8")).toBe("child");
	expect(requests.filter((request) => request.kind === "confirm")).toHaveLength(1);
	const record = listSessionRecords().find(
		(record) => record.childRun?.parentSessionId === created.sessionId,
	);
	expect(
		record?.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === "child-bash",
		),
	).toHaveLength(1);
	parent.assertComplete();
	child.assertComplete();
});

test("foreground child approval restores the same interaction after host restart", async () => {
	const parent = new ScriptedModel([agentCall(), done("parent complete")]);
	const child = new ScriptedModel([
		call("bash", { command: "printf x >> foreground-once.txt", timeoutMs: 1000 }, "child-bash"),
		done("child complete"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	setExtUiPublisher(() => {});
	const running = promptSession(created.sessionId, "Delegate the task");
	await until(() => getSessionState(created.sessionId).needsInput?.kind === "dialog");
	const before = getSessionState(created.sessionId).needsInput;
	if (before?.kind !== "dialog") throw new Error("Missing approval");
	await removeSession(created.sessionId);
	await running;
	expect(existsSync(join(cwd, "foreground-once.txt"))).toBe(false);
	await getSessionMessages(created.sessionId, "workspace", cwd);
	const restored = getSessionState(created.sessionId).needsInput;
	if (restored?.kind !== "dialog") throw new Error("Missing restored approval");
	expect(restored.request.id).toBe(before.request.id);
	approve(restored.request);
	await until(() => getSessionState(created.sessionId).completion?.outcome === "succeeded");
	expect(readFileSync(join(cwd, "foreground-once.txt"), "utf8")).toBe("x");
	parent.assertComplete();
	child.assertComplete();
});

test("foreground approval usage counts each model response once in both transcripts", async () => {
	const parent = new ScriptedModel([agentCall(), done("parent complete")]);
	const child = new ScriptedModel([
		modelResponse({
			output: [
				assistantMessage("I will run the check."),
				functionCall("bash", JSON.stringify({ command: "true", timeoutMs: 1000 }), {
					callId: "usage-bash",
				}),
			],
			usage: new Usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
		}),
		modelResponse({
			output: [assistantMessage("checked")],
			usage: new Usage({ inputTokens: 50, outputTokens: 10, totalTokens: 60 }),
		}),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	setExtUiPublisher(approve);
	await promptSession(created.sessionId, "Delegate");
	const record = listSessionRecords().find(
		(record) => record.childRun?.parentSessionId === created.sessionId,
	);
	if (!record) throw new Error("Missing child");
	expect(getSessionStats(record.sessionId).tokens.total).toBe(180);
	expect(getSessionStats(created.sessionId).tokens.total).toBe(180);
});

test("Stop during child creation prevents a late detached model run", async () => {
	const parent = new ScriptedModel([agentCall(true)]);
	const child = new ScriptedModel([done("must not run")]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	const original = modelConfiguration.listAvailableModels;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const listing = spyOn(modelConfiguration, "listAvailableModels").mockImplementation(async () => {
		if (++calls === 3) await gate;
		return original();
	});
	try {
		const running = promptSession(created.sessionId, "Delegate");
		await until(() => calls === 3);
		const stopping = abortSession(created.sessionId);
		release();
		await Promise.all([running, stopping]);
		expect(child.calls).toHaveLength(0);
		expect((await sessionResources("workspace", created.sessionId)).subagents[0]?.status).toBe(
			"aborted",
		);
	} finally {
		release();
		listing.mockRestore();
	}
});

test("custom child composition enforces selected Skills and extension opt-in", async () => {
	saveConfig({ ...loadConfig(), disabledExtensions: [] });
	for (const name of ["selected", "excluded"]) {
		const path = join(directory, "data", "skills", name);
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(path, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${name} procedure\n---\n${name}-body`,
		);
	}
	const agents = join(directory, "data", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(agents, "curated.md"),
		"---\nname: curated\ndescription: Selected Skill only\nskills: [selected]\ntools: [skill_search, skill_read, web_search]\n---\nUse only the selected procedure.",
	);
	writeFileSync(join(cwd, "AGENTS.md"), "WORKSPACE-ONLY instruction");
	const parent = new ScriptedModel([
		call("Agent", { subagent_type: "curated", task: "Read the selected Skill" }, "curated"),
		done(),
	]);
	const child = new ScriptedModel([
		call("skill_search", { query: "procedure", limit: null }, "selected-search"),
		call("skill_read", { name: "excluded", path: null }, "excluded-read"),
		done(),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate");
	const initial = child.calls[0]?.request;
	expect(initial?.systemInstructions).toContain("selected-body");
	expect(initial?.systemInstructions).not.toContain("excluded-body");
	expect(initial?.systemInstructions).not.toContain("<name>excluded</name>");
	expect(initial?.systemInstructions).not.toContain("WORKSPACE-ONLY");
	expect(initial?.tools.map((tool) => ("name" in tool ? tool.name : ""))).not.toContain(
		"web_search",
	);
	const record = listSessionRecords().find(
		(record) => record.childRun?.parentSessionId === created.sessionId,
	);
	expect(
		record?.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "excluded-read",
		),
	).toMatchObject({ isError: true });
});

test("a foreground child whose Skill fails to load ends as an error and releases its slot", async () => {
	const agents = join(directory, "data", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(agents, "broken.md"),
		"---\nname: broken\ndescription: Preloads a missing Skill\nskills: [missing]\n---\nUse the missing procedure.",
	);
	const parent = new ScriptedModel([
		call("Agent", { subagent_type: "broken", task: "Use the missing Skill" }, "broken"),
		agentCall(),
		done(),
	]);
	const child = new ScriptedModel([done("SECOND_CHILD")]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate twice");
	const statuses = (await sessionResources("workspace", created.sessionId)).subagents.map(
		(resource) => resource.status,
	);
	expect(statuses.sort()).toEqual(["completed", "error"]);
	const messages = readSessionRecord(created.sessionId)?.messages ?? [];
	const broken = messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "broken",
	);
	expect(broken).toMatchObject({ isError: true, details: { status: "error" } });
	if (broken?.role !== "toolResult" || !isDelegationRunDetails(broken.details))
		throw new Error("A failed child result must keep its details");
	expect(
		(await subagentTranscript("workspace", created.sessionId, broken.details.childSessionId))
			.status,
	).toBe("error");
	child.assertComplete();
});

test("background child completion survives normal parent completion and wakes it exactly once", async () => {
	writeFileSync(join(cwd, "fixture.txt"), "background fixture");
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const parent = new ScriptedModel([
		agentCall(true),
		done("parent waiting"),
		done("received completion"),
	]);
	const child = new ScriptedModel([
		modelResponder(async () => {
			await gate;
			return [assistantMessage("BACKGROUND_REPORT")];
		}),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate in the background");
	expect((await sessionResources("workspace", created.sessionId)).subagents[0]?.status).toBe(
		"running",
	);
	release();
	await until(
		() =>
			readSessionRecord(created.sessionId)?.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some(
						(part) => part.type === "text" && part.text === "received completion",
					),
			) === true,
	);
	const record = readSessionRecord(created.sessionId);
	expect(
		record?.messages.filter(
			(message) => message.role === "custom" && message.customType === "subagent-completion",
		),
	).toHaveLength(1);
	expect(record?.messages.filter((message) => message.role === "user")).toHaveLength(1);
	expect((await sessionResources("workspace", created.sessionId)).subagents[0]?.status).toBe(
		"completed",
	);
	parent.assertComplete();
	child.assertComplete();
});

test("parent Stop cancels owned background work and rejects another parent's controls", async () => {
	const parent = new ScriptedModel([agentCall(true), done("waiting")]);
	const child = new ScriptedModel([
		modelResponder(async ({ request }) => {
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
					once: true,
				});
			});
			return [assistantMessage("done")];
		}),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate");
	const resource = (await sessionResources("workspace", created.sessionId)).subagents[0];
	if (!resource) throw new Error("Missing child resource");
	const other = await createSession({ cwd, workspaceId: "workspace" });
	await expect(stopSubagent("workspace", other.sessionId, resource.childSessionId)).rejects.toThrow(
		"Resource unavailable",
	);
	await abortSession(created.sessionId);
	expect((await sessionResources("workspace", created.sessionId)).subagents[0]?.status).toBe(
		"aborted",
	);
	expect(
		readSessionRecord(created.sessionId)?.messages.filter(
			(message) => message.role === "custom" && message.customType === "subagent-completion",
		),
	).toHaveLength(0);
	expect(existsSync(join(cwd, "unexpected"))).toBe(false);
});

test("SDK command and Plan dispatch preserve UI details while the model receives bounded content", async () => {
	const model = new ScriptedModel([
		call("todo_add", { title: "Add actual Plan state", group: "Stage 3" }, "plan-add"),
		call(
			"background_command",
			{ action: "start", command: "printf COMMAND_LOG", name: "fixture", timeout: 2 },
			"command-start",
		),
		done("waiting"),
		done("received output"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory(() => model);
	setExtUiPublisher(approve);
	await promptSession(created.sessionId, "Create the Plan and run a background command");
	await until(
		() =>
			readSessionRecord(created.sessionId)?.messages.some(
				(message) =>
					message.role === "custom" && message.customType === "background-command-completion",
			) === true,
	);
	const resources = await sessionResources("workspace", created.sessionId);
	const command = resources.commands[0];
	if (!command) throw new Error("Missing command resource");
	const output = await backgroundCommandOutput("workspace", created.sessionId, command.id);
	expect(output).toMatchObject({
		available: true,
		output: { text: "COMMAND_LOG", truncated: false },
	});
	expect(new TodoStore(cwd, created.sessionId).read().groups[0]?.todos[0]?.title).toBe(
		"Add actual Plan state",
	);
	const record = readSessionRecord(created.sessionId);
	const planResult = record?.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "plan-add",
	);
	expect(planResult?.role === "toolResult" && planResult.details !== undefined).toBe(true);
	const modelResult = record?.history.find(
		(item) => item.type === "function_call_result" && item.callId === "plan-add",
	);
	expect(
		modelResult?.type === "function_call_result" &&
			typeof modelResult.output === "string" &&
			modelResult.output.includes('"details"'),
	).toBe(false);
});

test("background child approvals use the parent UI without replacing another owned request", async () => {
	saveConfig({ ...loadConfig(), subagentMaxConcurrent: 2 });
	const parent = new ScriptedModel([
		modelResponse([
			functionCall(
				"Agent",
				JSON.stringify({ subagent_type: "worker", task: "A", run_in_background: true }),
				{ callId: "a" },
			),
			functionCall(
				"Agent",
				JSON.stringify({ subagent_type: "worker", task: "B", run_in_background: true }),
				{ callId: "b" },
			),
		]),
		call("bash", { command: "printf parent > parent.txt", timeoutMs: 1000 }, "parent-bash"),
		done("waiting"),
		done("received one"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	const children = new Map<string, ScriptedModel>();
	configureAgentModelFactory((_model, id) => {
		if (id === created.sessionId) return parent;
		let model = children.get(id);
		if (!model) {
			const task = readSessionRecord(id)?.childRun?.task;
			model = new ScriptedModel([
				call("bash", { command: `printf ${task} > ${task}.txt`, timeoutMs: 1000 }, `bash-${task}`),
				done(`report ${task}`),
			]);
			children.set(id, model);
		}
		return model;
	});
	const requests: ExtUiRequest[] = [];
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") requests.push(request);
	});
	const running = promptSession(created.sessionId, "Delegate both tasks");
	await until(() => requests.length === 3);
	expect(requests.every((request) => request.sessionId === created.sessionId)).toBe(true);
	const own = getSessionState(created.sessionId).needsInput;
	if (own?.kind !== "dialog" || own.request.toolCallId !== "parent-bash")
		throw new Error("The parent's approval must retain priority");
	approve(own.request);
	await running;
	expect(readFileSync(join(cwd, "parent.txt"), "utf8")).toBe("parent");
	const first = getSessionState(created.sessionId).needsInput;
	if (first?.kind !== "dialog" || first.request.kind !== "confirm")
		throw new Error("Missing parent-routed child request");
	expect(requests.some((request) => request.id === first.request.id)).toBe(true);
	approve(first.request);
	await until(() => existsSync(join(cwd, "A.txt")) || existsSync(join(cwd, "B.txt")));
	const second = getSessionState(created.sessionId).needsInput;
	if (second?.kind !== "dialog" || second.request.kind !== "confirm")
		throw new Error("Missing second request");
	expect(second.request.id).not.toBe(first.request.id);
	await abortSession(created.sessionId);
	expect(getSessionState(created.sessionId).needsInput).toBeNull();
	expect(() => approve(second.request)).toThrow();
	expect(Number(existsSync(join(cwd, "A.txt"))) + Number(existsSync(join(cwd, "B.txt")))).toBe(1);
});

test("background child approval restores its owned checkpoint and does not repeat the command", async () => {
	const parent = new ScriptedModel([agentCall(true), done("waiting"), done("received")]);
	const child = new ScriptedModel([
		call("bash", { command: "printf x >> once.txt", timeoutMs: 1000 }, "restart-child-bash"),
		done("child complete"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	setExtUiPublisher(() => {});
	await promptSession(created.sessionId, "Delegate");
	await until(() => getSessionState(created.sessionId).needsInput?.kind === "dialog");
	const before = getSessionState(created.sessionId).needsInput;
	if (
		before?.kind !== "dialog" ||
		before.request.kind !== "confirm" ||
		!before.request.toolCallId ||
		!before.request.runId ||
		before.request.revision === undefined
	)
		throw new Error("Missing owned request");
	await removeSession(created.sessionId);
	expect(existsSync(join(cwd, "once.txt"))).toBe(false);
	await getSessionMessages(created.sessionId, "workspace", cwd);
	const restored = getSessionState(created.sessionId).needsInput;
	expect(restored?.kind === "dialog" && restored.request.id).toBe(before.request.id);
	const response = {
		sessionId: created.sessionId,
		id: before.request.id,
		runId: before.request.runId,
		revision: before.request.revision,
		toolCallId: before.request.toolCallId,
		value: true,
	};
	await attachApprovalOwner(response);
	resolveExtUi(response);
	await until(
		() => existsSync(join(cwd, "once.txt")) && readFileSync(join(cwd, "once.txt"), "utf8") === "x",
	);
	await until(() =>
		listSessionRecords().some(
			(record) =>
				record.childRun?.parentSessionId === created.sessionId &&
				record.childRun.status === "completed",
		),
	);
	await attachApprovalOwner(response);
	resolveExtUi(response);
	expect(readFileSync(join(cwd, "once.txt"), "utf8")).toBe("x");
	child.assertComplete();
});

test("queued children respect the concurrency limit and parent Stop prevents queued execution", async () => {
	const parent = new ScriptedModel([
		modelResponse([
			functionCall(
				"Agent",
				JSON.stringify({ subagent_type: "worker", task: "hold A", run_in_background: true }),
				{ callId: "a" },
			),
			functionCall(
				"Agent",
				JSON.stringify({ subagent_type: "worker", task: "hold B", run_in_background: true }),
				{ callId: "b" },
			),
		]),
		done("waiting"),
	]);
	const child = new ScriptedModel([
		modelResponder(async ({ request }) => {
			await new Promise<void>((_resolve, reject) =>
				request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
					once: true,
				}),
			);
			return [assistantMessage("unreachable")];
		}),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate two");
	const resources = await sessionResources("workspace", created.sessionId);
	expect(resources.subagents.map((resource) => resource.status).sort()).toEqual([
		"queued",
		"running",
	]);
	expect(child.calls).toHaveLength(1);
	await abortSession(created.sessionId);
	expect(
		(await sessionResources("workspace", created.sessionId)).subagents.map(
			(resource) => resource.status,
		),
	).toEqual(["aborted", "aborted"]);
	expect(child.calls).toHaveLength(1);
});

test("model output collection claims command completion and retains the renderer metadata", async () => {
	let sessionId = "";
	const model = new ScriptedModel([
		call(
			"background_command",
			{ action: "start", command: "printf CLAIMED", name: "claim" },
			"start",
		),
		modelResponder(async () => {
			let resource = (await sessionResources("workspace", sessionId)).commands[0];
			for (let index = 0; index < 100; index++) {
				resource = (await sessionResources("workspace", sessionId)).commands[0];
				if (resource?.finishedAt !== undefined) break;
				await Bun.sleep(5);
			}
			if (!resource) throw new Error("Missing command");
			return [
				functionCall("background_command", JSON.stringify({ action: "output", id: resource.id }), {
					callId: "output",
				}),
			];
		}),
		done("collected"),
	]);
	sessionId = (await createSession({ cwd, workspaceId: "workspace" })).sessionId;
	configureAgentModelFactory(() => model);
	setExtUiPublisher(approve);
	await promptSession(sessionId, "Start and collect");
	const record = readSessionRecord(sessionId);
	expect(
		record?.messages.filter(
			(message) =>
				message.role === "custom" && message.customType === "background-command-completion",
		),
	).toHaveLength(0);
	const result = record?.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "output",
	);
	expect(result).toMatchObject({
		details: { snapshot: { status: "completed" }, output: { text: "CLAIMED" } },
	});
	model.assertComplete();
});

for (const control of ["parent", "child", "all", "command"] as const) {
	test.skipIf(process.platform === "win32")(
		`${control} Stop cleans commands owned by a completed child`,
		async () => {
			const parent = new ScriptedModel([agentCall(true), done("started"), done("received child")]);
			const child = new ScriptedModel([
				call(
					"background_command",
					{
						action: "start",
						command: 'sleep 30 & printf "%s" "$!" > child-pid.txt; printf CHILD_READY; wait',
						name: "child command",
						timeout: 40,
					},
					"child-command",
				),
				done("command started"),
			]);
			const created = await createSession({ cwd, workspaceId: "workspace" });
			configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
			setExtUiPublisher(approve);
			try {
				await promptSession(created.sessionId, "Delegate a background command");
				await until(() =>
					listSessionRecords().some(
						(record) =>
							record.childRun?.parentSessionId === created.sessionId &&
							record.childRun.status === "completed",
					),
				);
				const record = listSessionRecords().find(
					(record) => record.childRun?.parentSessionId === created.sessionId,
				);
				if (!record) throw new Error("Missing child");
				await until(
					() =>
						existsSync(join(cwd, "child-pid.txt")) &&
						readFileSync(join(cwd, "child-pid.txt"), "utf8").length > 0,
				);
				const pid = Number(readFileSync(join(cwd, "child-pid.txt"), "utf8"));
				expect(pid).toBeGreaterThan(0);
				expect(() => process.kill(pid, 0)).not.toThrow();
				const result = record.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "child-command",
				);
				if (result?.role !== "toolResult") throw new Error("Missing command result");
				const details = result.details as { snapshot: { id: string } };
				expect((await sessionResources("workspace", created.sessionId)).commands).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: details.snapshot.id,
							sessionId: record.sessionId,
							status: "running",
						}),
					]),
				);
				expect(getSessionState(created.sessionId)?.backgroundWork).toBe(true);
				expect(
					await backgroundCommandOutput("workspace", created.sessionId, details.snapshot.id),
				).toMatchObject({ available: true, output: { text: "CHILD_READY" } });
				await until(() => readSessionRecord(created.sessionId)?.state.execution === "idle");
				const parentCalls = parent.calls.length;
				if (control === "parent") await abortSession(created.sessionId);
				else if (control === "child")
					await stopSubagent("workspace", created.sessionId, record.sessionId);
				else if (control === "all")
					expect(await stopSubagents("workspace", created.sessionId)).toBe(1);
				else await stopBackgroundCommand("workspace", created.sessionId, details.snapshot.id);
				await until(() => {
					try {
						process.kill(pid, 0);
						return false;
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
						throw error;
					}
				});
				await until(
					() =>
						archivedCommandOutput(
							{ workspaceId: "workspace", sessionId: record.sessionId },
							details.snapshot.id,
						) !== undefined,
				);
				expect(readSessionRecord(record.sessionId)?.childRun?.status).toBe("completed");
				expect(
					archivedCommandOutput(
						{ workspaceId: "workspace", sessionId: record.sessionId },
						details.snapshot.id,
					)?.text,
				).toContain("CHILD_READY");
				expect(parent.calls).toHaveLength(parentCalls);
				expect(
					readSessionRecord(created.sessionId)?.messages.some(
						(message) =>
							message.role === "custom" && message.customType === "background-command-completion",
					),
				).toBe(false);
				expect(child.calls).toHaveLength(2);
				expect(getSessionState(created.sessionId)?.backgroundWork).toBe(false);
				expect(
					(await sessionResourceHistory("workspace", created.sessionId, { kind: "command" })).items,
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ id: details.snapshot.id, status: "stopped" }),
					]),
				);
			} finally {
				await abortSession(created.sessionId);
			}
		},
	);
}

test("a foreground child model factory failure releases its slot for the next child", async () => {
	const parent = new ScriptedModel([
		agentCall(),
		call("Agent", { subagent_type: "worker", task: "Retry" }, "retry-child"),
		done(),
	]);
	const child = new ScriptedModel([done("second child completed")]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	let children = 0;
	configureAgentModelFactory((_model, id) => {
		if (id === created.sessionId) return parent;
		if (++children === 1) throw new Error("Fixture child model setup failed");
		return child;
	});
	await promptSession(created.sessionId, "Delegate twice");
	const records = listSessionRecords().filter(
		(record) => record.childRun?.parentSessionId === created.sessionId,
	);
	expect(records.map((record) => record.childRun?.status).sort()).toEqual(["completed", "error"]);
	expect(child.calls).toHaveLength(1);
	const result = readSessionRecord(created.sessionId)?.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "child-call",
	);
	expect(result).toMatchObject({ isError: true });
});

for (const mode of ["repository", "selected", "chat"] as const) {
	test(`actual ${mode} child request applies its Spec and tool scope`, async () => {
		if (mode === "chat")
			saveWorkspaces(loadWorkspaces().map((workspace) => ({ ...workspace, kind: "chat" })));
		if (mode === "selected") {
			const agents = join(directory, "data", "agents");
			mkdirSync(agents, { recursive: true });
			writeFileSync(
				join(agents, "selected.md"),
				"---\nname: selected\ndescription: Selected tools\ntools: [read, spec_get]\n---\nInspect only.",
			);
		}
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: mode === "selected" ? "selected" : "worker", task: "Inspect" },
				"scoped-child",
			),
			done(),
		]);
		const child = new ScriptedModel([done("inspected")]);
		const created = await createSession({ cwd, workspaceId: "workspace" });
		configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
		await promptSession(created.sessionId, "Delegate");
		const names =
			child.calls[0]?.request.tools.map((tool) => ("name" in tool ? tool.name : "")) ?? [];
		expect(child.calls).toHaveLength(1);
		const specNames = names.filter((name) => name.startsWith("spec_"));
		if (mode === "repository") expect(specNames).toHaveLength(8);
		else expect(specNames).toEqual(mode === "selected" ? ["spec_get"] : []);
		expect(names).not.toContain("Agent");
		expect(names).not.toContain("ask_user_question");
		expect(names).not.toContain("tool_search");
		expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
	});
}

test("a child command completes visibly in its parent without restarting the completed child", async () => {
	const parent = new ScriptedModel([
		agentCall(true),
		done("started"),
		done("received child"),
		done("received command"),
	]);
	const child = new ScriptedModel([
		call(
			"background_command",
			{
				action: "start",
				command: "while [ ! -f release-command ]; do sleep 0.01; done; printf CHILD_DONE",
				name: "child completion",
				timeout: 5,
			},
			"child-command",
		),
		done("started command"),
	]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	setExtUiPublisher(approve);
	await promptSession(created.sessionId, "Delegate a command");
	await until(() =>
		listSessionRecords().some(
			(record) =>
				record.childRun?.parentSessionId === created.sessionId &&
				record.childRun.status === "completed",
		),
	);
	const record = listSessionRecords().find(
		(record) => record.childRun?.parentSessionId === created.sessionId,
	);
	if (!record) throw new Error("Missing child");
	await until(() => readSessionRecord(created.sessionId)?.state.execution === "idle");
	const commands = (await sessionResources("workspace", created.sessionId)).commands;
	const id = commands[0]?.id;
	if (!id) throw new Error("Missing parent-visible command");
	const other = await createSession({ cwd, workspaceId: "workspace" });
	expect(await backgroundCommandOutput("workspace", other.sessionId, id)).toEqual({
		available: false,
	});
	writeFileSync(join(cwd, "release-command"), "release");
	await until(
		() =>
			readSessionRecord(created.sessionId)?.messages.some(
				(message) =>
					message.role === "custom" && message.customType === "background-command-completion",
			) === true,
	);
	await until(() => readSessionRecord(created.sessionId)?.state.execution === "idle");
	expect(
		readSessionRecord(created.sessionId)?.messages.filter(
			(message) =>
				message.role === "custom" && message.customType === "background-command-completion",
		),
	).toHaveLength(1);
	expect(
		readSessionRecord(record.sessionId)?.messages.some(
			(message) =>
				message.role === "custom" && message.customType === "background-command-completion",
		),
	).toBe(false);
	const notice = readSessionRecord(created.sessionId)?.messages.find(
		(message) =>
			message.role === "custom" && message.customType === "background-command-completion",
	);
	expect(notice?.role === "custom" && notice.details).not.toHaveProperty("command");

	expect(child.calls).toHaveLength(2);
	expect(await backgroundCommandOutput("workspace", created.sessionId, id)).toMatchObject({
		available: true,
		output: { text: "CHILD_DONE" },
	});
	await settleSessionsForShutdown();
	disposeAllSessions();
	expect((await sessionResources("workspace", created.sessionId)).commands).toEqual(
		expect.arrayContaining([expect.objectContaining({ id, status: "completed" })]),
	);
	expect(await backgroundCommandOutput("workspace", created.sessionId, id)).toMatchObject({
		available: true,
		output: { text: "CHILD_DONE" },
	});
	const finishedAt = Date.now() + 100;
	for (let index = 0; index < 21; index++)
		recordResource(
			{ workspaceId: "workspace", sessionId: record.sessionId },
			{
				kind: "command",
				summary: {
					id: `newer-${index}`,
					sessionId: record.sessionId,
					name: "newer",
					command: "fixture",
					status: "completed",
					startedAt: finishedAt + index,
					finishedAt: finishedAt + index + 1,
					exitCode: 0,
				},
			},
			{ text: "newer log", truncated: false },
		);
	expect(
		(await sessionResources("workspace", created.sessionId)).commands.some(
			(command) => command.id === id,
		),
	).toBe(false);
	expect(
		(await sessionResourceHistory("workspace", created.sessionId, { kind: "command", limit: 100 }))
			.items,
	).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
	expect(await backgroundCommandOutput("workspace", created.sessionId, id)).toMatchObject({
		available: true,
		output: { text: "CHILD_DONE" },
	});
});

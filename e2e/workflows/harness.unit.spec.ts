import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	type AskUserQuestionItem,
	type AskUserQuestionResult,
	buildQuestionnaireResponse,
} from "@thinkrail/ask-user-question/core";
import type {
	AssistantMessage,
	SessionEvent,
	SessionInputState,
	ToolResultMessage,
	TranscriptMessage,
	WsResult,
} from "@thinkrail/contracts";
import type { E2eWire } from "../fixtures/wire";
import {
	checkBudget,
	checks,
	DEFAULT_BUDGET,
	driveTurn,
	EventLog,
	FIXTURE_MD_SUFFIX,
	includeInFixtureSnapshot,
	maskFixtureMarkdown,
	parseJudgeReply,
	parseOnTrackReply,
	parsePersonaReply,
	parseSimReply,
	pickRecommended,
	runChecks,
	signals,
	skipAll,
	unmaskFixtureMarkdown,
	watchSignals,
} from "./harness";

function toolStart(id: string, name: string, args: Record<string, unknown>): SessionEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName: name, args } as SessionEvent;
}
function toolEnd(id: string, name: string, result: unknown): SessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result,
		isError: false,
	} as SessionEvent;
}
function turnEnd(): SessionEvent {
	return { type: "agent_settled", terminal: { stopReason: "stop" } };
}

function skillRead(id: string, name: string, path: string | null = null): SessionEvent[] {
	return [toolStart(id, "skill_read", { name, path }), toolEnd(id, "skill_read", "…")];
}

function routedLog(): EventLog {
	const log = new EventLog();
	for (const event of [
		...skillRead("t1", "choosing-a-workflow"),
		...skillRead("t2", "brainstorming"),
	])
		log.push(event);
	log.push(turnEnd());
	return log;
}

test("EventLog: tool calls, skill reads, turn count", () => {
	const log = routedLog();
	expect(log.toolCalls("skill_read")).toHaveLength(2);
	expect(log.skillReads()).toEqual(["choosing-a-workflow", "brainstorming"]);
	expect(log.turnCount()).toBe(1);
	for (const event of skillRead("t3", "importing-a-codebase", "references/notes.md"))
		log.push(event);
	log.push(toolStart("t4", "skill_read", { name: "importing-a-codebase", path: null }));
	log.push({ ...toolEnd("t4", "skill_read", "denied"), isError: true } as SessionEvent);
	log.push(toolStart("t5", "read", { path: "/repo/.agents/skills/importing-a-codebase/SKILL.md" }));
	expect(log.skillReads()).toHaveLength(2);
});

function assistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function completedCall(id: string, name: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "body" }],
		isError: false,
		timestamp: 2,
	};
}

test("EventLog reconstructs ordered successful reads, pending calls, errors and text from snapshots", () => {
	const messages: TranscriptMessage[] = [
		assistantCall("a", "skill_read", { name: "choosing-a-workflow", path: null }),
		completedCall("a", "skill_read"),
		assistantCall("b", "skill_read", { name: "brainstorming", path: null }),
		completedCall("b", "skill_read"),
		assistantCall("c", "skill_read", { name: "brainstorming", path: "fixing-a-bug.md" }),
		completedCall("c", "skill_read"),
		assistantCall("d", "skill_read", { name: "shipping-a-pr", path: null }),
		{ ...completedCall("d", "skill_read"), isError: true },
		assistantCall("pending", "apply_patch", { path: "src/index.ts" }),
		{
			...assistantCall("text", "unused", {}),
			content: [{ type: "text", text: "Ready" }],
		},
	];
	const log = EventLog.fromMessages(messages);
	expect(log.skillReads()).toEqual(["choosing-a-workflow", "brainstorming"]);
	expect(log.toolCalls().map((call) => call.toolCallId)).toEqual(["a", "b", "c", "d", "pending"]);
	expect(log.toolCalls("apply_patch")[0]?.result).toBeUndefined();
	expect(log.toolCalls("skill_read")[3]?.isError).toBe(true);
	expect(log.assistantTexts()).toEqual(["Ready"]);
});

function turnSnapshot(
	messages: TranscriptMessage[] = [],
	needsInput: SessionInputState | null = null,
): WsResult<"session.getMessages"> {
	return {
		messages,
		summary: {
			sessionId: "session",
			workspaceId: "workspace",
			title: "test",
			model: null,
			thinkingLevel: "off",
			isStreaming: false,
			messageCount: messages.length,
			updatedAt: 0,
			live: true,
			state: {
				execution: "idle",
				runId: null,
				needsInput,
				completion:
					needsInput || messages.length === 0
						? null
						: { completionId: "run", outcome: "succeeded" },
				completionUnread: false,
				queuedCount: 0,
				backgroundWork: false,
			},
		},
	};
}

function scriptedWire(snapshots: WsResult<"session.getMessages">[]) {
	const requests: { method: string; params: unknown; timeoutMs: number | undefined }[] = [];
	let index = 0;
	let acknowledge: () => void = () => {};
	const prompt = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	const request = async (method: string, params: unknown, timeoutMs?: number) => {
		requests.push({ method, params, timeoutMs });
		if (method === "session.prompt") await prompt;
		if (method === "session.abort") acknowledge();
		if (method === "session.getMessages") return snapshots[Math.min(index++, snapshots.length - 1)];
		return { ok: true };
	};
	return { request: request as E2eWire["request"], requests };
}

const IDS = { workspaceId: "workspace", sessionId: "session" };

test("driveTurn: forbidden signal wins over stop and returns the settled snapshot", async () => {
	const routed = turnSnapshot([
		assistantCall("a", "skill_read", { name: "brainstorming", path: null }),
		completedCall("a", "skill_read"),
	]);
	const wire = scriptedWire([turnSnapshot(), routed]);
	const turn = await driveTurn(wire, IDS, "route", {
		stopWhen: [signals.skillRead("brainstorming")],
		forbid: [signals.skillRead("brainstorming")],
	});
	expect(turn.failure).toContain("brainstorming");
	expect(turn.stoppedBy).toBeNull();
	expect(turn.snapshot).toEqual(routed);
	expect(wire.requests.map((request) => request.method).slice(-2)).toEqual([
		"session.abort",
		"session.getMessages",
	]);
});

test("driveTurn: a satisfied routing stop aborts before a subsequent bash approval", async () => {
	const messages = [
		assistantCall("route", "skill_read", { name: "brainstorming", path: null }),
		completedCall("route", "skill_read"),
		assistantCall("inspect", "bash", { command: "pwd && ls -la", timeoutMs: 15000 }),
	];
	const pending = turnSnapshot(messages, {
		kind: "dialog",
		interactionId: "approval",
		request: {
			kind: "confirm",
			id: "approval",
			sessionId: "session",
			runId: "run",
			revision: 7,
			toolCallId: "inspect",
			toolInput: { command: "pwd && ls -la", timeoutMs: 15000 },
			title: "Allow bash?",
			message: "inspect",
		},
	});
	const wire = scriptedWire([turnSnapshot(), pending, turnSnapshot(messages)]);
	const request = wire.request;
	let abortSettled = false;
	wire.request = async (method, params, timeoutMs) => {
		const result = await request(method, params, timeoutMs);
		if (method === "session.abort") {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			abortSettled = true;
		}
		return result;
	};
	const stop = signals.skillRead("brainstorming");
	const turn = await driveTurn(wire, IDS, "route", { stopWhen: [stop] });
	expect(turn.failure).toBeNull();
	expect(turn.stoppedBy).toBe(stop.description);
	expect(turn.answered).toEqual([]);
	expect(abortSettled).toBe(true);
	expect(
		wire.requests.filter((request) =>
			["session.extUiReply", "session.respondToTool"].includes(request.method),
		),
	).toEqual([]);
});

test("driveTurn: disallowed approval is denied before abort", async () => {
	const pending = turnSnapshot([assistantCall("edit", "apply_patch", { path: "other.ts" })], {
		kind: "dialog",
		interactionId: "approval",
		request: {
			kind: "confirm",
			id: "approval",
			sessionId: "session",
			runId: "run",
			revision: 7,
			toolCallId: "edit",
			toolInput: { path: "other.ts" },
			title: "Allow apply_patch?",
			message: "edit",
		},
	});
	const wire = scriptedWire([turnSnapshot(), pending, turnSnapshot(pending.messages)]);
	const turn = await driveTurn(wire, IDS, "edit", {
		allowConfirm: (call) =>
			call.toolName === "apply_patch" && call.args.path === "src/resize/index.ts",
	});
	expect(turn.failure).toBe("Forbidden approval: apply_patch");
	const decision = wire.requests.findIndex((request) => request.method === "session.extUiReply");
	expect(wire.requests[decision]?.params).toEqual({
		response: {
			id: "approval",
			sessionId: "session",
			runId: "run",
			toolCallId: "edit",
			revision: 7,
			value: false,
		},
	});
	expect(wire.requests[decision + 1]?.method).toBe("session.abort");
});

function confirmSnapshot(toolName: string, args: Record<string, unknown>) {
	return turnSnapshot([assistantCall("confirm", toolName, args)], {
		kind: "dialog",
		interactionId: "approval",
		request: {
			kind: "confirm",
			id: "approval",
			sessionId: "session",
			runId: "run",
			revision: 7,
			toolCallId: "confirm",
			toolInput: args,
			title: `Allow ${toolName}?`,
			message: "confirm",
		},
	});
}

test("driveTurn: deferred approval waits for an external decision without answering twice", async () => {
	const pending = confirmSnapshot("bash", { command: "pwd", timeoutMs: 10000 });
	const done = turnSnapshot([...pending.messages, completedCall("confirm", "bash")]);
	const wire = scriptedWire([turnSnapshot(), pending, pending, done]);
	let deferred = 0;
	const turn = await driveTurn(wire, IDS, "inspect", {
		allowConfirm: () => {
			deferred++;
			return undefined;
		},
	});
	expect(deferred).toBe(2);
	expect(turn.failure).toBeNull();
	expect(turn.answered).toEqual([]);
	expect(turn.snapshot).toEqual(done);
	expect(turn.log.toolCalls("bash")[0]?.isError).toBe(false);
	expect(wire.requests.filter((request) => request.method === "session.extUiReply")).toEqual([]);
});

for (const missingCall of [false, true]) {
	test(`driveTurn: ${missingCall ? "a missing call" : "no approval callback"} still denies`, async () => {
		const pending = confirmSnapshot("bash", { command: "pwd", timeoutMs: 10000 });
		if (missingCall) pending.messages = [];
		const wire = scriptedWire([turnSnapshot(), pending, turnSnapshot(pending.messages)]);
		let callbackCalled = false;
		const turn = await driveTurn(wire, IDS, "inspect", {
			...(missingCall
				? {
						allowConfirm: () => {
							callbackCalled = true;
							return undefined;
						},
					}
				: {}),
		});
		expect(turn.failure).toContain("Forbidden approval:");
		expect(callbackCalled).toBe(false);
		expect(
			wire.requests.find((request) => request.method === "session.extUiReply")?.params,
		).toMatchObject({ response: { value: false } });
	});
}

for (const monitor of ["forbid", "stop", "budget"] as const) {
	test(`driveTurn: ${monitor} remains active while approval is deferred`, async () => {
		const pending = confirmSnapshot("bash", { command: "pwd", timeoutMs: 10000 });
		const arrived = {
			...pending,
			messages: [
				...pending.messages,
				...(monitor === "budget"
					? Array.from({ length: DEFAULT_BUDGET.maxToolCalls }, (_, index) =>
							assistantCall(`read-${index}`, "read", { path: "AGENTS.md" }),
						)
					: [
							assistantCall("route", "skill_read", { name: "brainstorming", path: null }),
							completedCall("route", "skill_read"),
						]),
			],
		};
		const wire = scriptedWire([turnSnapshot(), pending, arrived, turnSnapshot(arrived.messages)]);
		let deferred = 0;
		const signal = signals.skillRead("brainstorming");
		const turn = await driveTurn(wire, IDS, "inspect", {
			allowConfirm: () => {
				deferred++;
				return undefined;
			},
			...(monitor === "forbid" ? { forbid: [signal] } : {}),
			...(monitor === "stop" ? { stopWhen: [signal] } : {}),
		});
		expect(deferred).toBe(1);
		expect(turn.failure).toBe(
			monitor === "stop"
				? null
				: monitor === "forbid"
					? signal.description
					: `budget: ${DEFAULT_BUDGET.maxToolCalls} tool calls reached`,
		);
		expect(turn.stoppedBy).toBe(monitor === "stop" ? signal.description : null);
		expect(turn.answered).toEqual([]);
		expect(wire.requests.filter((request) => request.method === "session.extUiReply")).toEqual([]);
	});
}

test("driveTurn: the exact requested patch still receives one immediate approval", async () => {
	const pending = confirmSnapshot("apply_patch", { path: "src/resize/index.ts" });
	const done = turnSnapshot([...pending.messages, completedCall("confirm", "apply_patch")]);
	const wire = scriptedWire([turnSnapshot(), pending, done]);
	const turn = await driveTurn(wire, IDS, "rename", {
		allowConfirm: (call) =>
			call.toolName === "apply_patch" && call.args.path === "src/resize/index.ts",
	});
	expect(turn.failure).toBeNull();
	expect(turn.answered).toEqual(["approval"]);
	const replies = wire.requests.filter((request) => request.method === "session.extUiReply");
	expect(replies).toHaveLength(1);
	expect(replies[0]?.params).toMatchObject({ response: { value: true, toolCallId: "confirm" } });
});

test("driveTurn: handles a question while the prompt RPC is pending", async () => {
	const call = assistantCall("question", "ask_user_question", { questions: [] });
	const pending = turnSnapshot([call], {
		kind: "tool-response",
		interactionId: "interaction",
		toolCallId: "question",
		runId: "run",
		revision: 4,
	});
	const done = turnSnapshot([call, completedCall("question", "ask_user_question")]);
	const wire = scriptedWire([turnSnapshot(), pending, done]);
	const turn = await driveTurn(wire, IDS, "ask");
	expect(turn.failure).toBeNull();
	expect(
		wire.requests.find((request) => request.method === "session.respondToTool")?.params,
	).toEqual({
		sessionId: "session",
		toolCallId: "question",
		runId: "run",
		interactionId: "interaction",
		revision: 4,
		response: skipAll(),
	});
	expect(turn.answered).toEqual(["interaction"]);
	expect(wire.requests.find((request) => request.method === "session.prompt")?.timeoutMs).toBe(
		DEFAULT_BUDGET.maxMs,
	);
});

test("driveTurn: custom refusal uses the native question result and preserves it in the transcript", async () => {
	const question = {
		header: "Scope",
		question: "Should I review or extend the existing graph?",
		options: [{ label: "Review", description: "Review the graph." }],
	};
	const response: AskUserQuestionResult = {
		cancelled: false,
		answers: [
			{
				questionIndex: 0,
				question: question.question,
				kind: "custom",
				answer: "Do not review or extend anything. Do not proceed; leave all files unchanged.",
			},
		],
	};
	const call = assistantCall("question", "ask_user_question", { questions: [question] });
	const pending = turnSnapshot([call], {
		kind: "tool-response",
		interactionId: "interaction",
		toolCallId: "question",
		runId: "run",
		revision: 4,
	});
	const nativeResult = buildQuestionnaireResponse(response, { questions: [question] });
	const done = turnSnapshot([
		call,
		{
			...completedCall("question", "ask_user_question"),
			content: nativeResult.content,
			details: nativeResult.details,
		},
	]);
	const wire = scriptedWire([turnSnapshot(), pending, done]);
	const turn = await driveTurn(wire, IDS, "offer", { answer: () => response });
	expect(turn.failure).toBeNull();
	expect(
		wire.requests.find((request) => request.method === "session.respondToTool")?.params,
	).toMatchObject({ toolCallId: "question", response });
	expect(turn.log.toolCalls("ask_user_question")[0]?.result).toMatchObject({ details: response });
	expect(turn.log.toolCalls().map((call) => call.toolName)).toEqual(["ask_user_question"]);
});

test("driveTurn: success without the required routing signal fails", async () => {
	const done = turnSnapshot([{ role: "user", content: "route", timestamp: 1 }]);
	const wire = scriptedWire([turnSnapshot(), done]);
	const turn = await driveTurn(wire, IDS, "route", {
		stopWhen: [signals.skillRead("brainstorming")],
	});
	expect(turn.failure).toBe("Turn completed without its stop signal");
});

test("driveTurn: abort failure retains the snapshot and fails acceptance", async () => {
	const snapshot = turnSnapshot([{ role: "user", content: "answer", timestamp: 1 }]);
	const wire = scriptedWire([turnSnapshot(), snapshot]);
	const request = wire.request;
	wire.request = async (method, params) => {
		if (method === "session.abort") {
			await request(method, params);
			throw new Error("host closed");
		}
		return request(method, params);
	};
	const turn = await driveTurn(wire, IDS, "answer");
	expect(turn.failure).toBe("Failed to settle after abort: host closed");
	expect(turn.snapshot).toEqual(snapshot);
});

test("driveTurn: ignores the old idle completion until the new prompt is admitted", async () => {
	const oldMessage: TranscriptMessage = { role: "user", content: "previous turn", timestamp: 1 };
	const old = turnSnapshot([oldMessage]);
	const call = assistantCall("question", "ask_user_question", { questions: [] });
	const pending = turnSnapshot([oldMessage, call], {
		kind: "tool-response",
		interactionId: "interaction",
		toolCallId: "question",
		runId: "new-run",
		revision: 4,
	});
	const done = turnSnapshot([oldMessage, call, completedCall("question", "ask_user_question")]);
	const wire = scriptedWire([old, old, pending, done]);
	const turn = await driveTurn(wire, IDS, "ask");
	expect(turn.failure).toBeNull();
	expect(turn.answered).toEqual(["interaction"]);
	expect(turn.snapshot).toEqual(done);
	expect(
		turn.log.events.some((event) => event.type === "message_end" && event.message === oldMessage),
	).toBe(false);
});

test("driveTurn: a rejected prompt fails promptly and aborts the session", async () => {
	const wire = scriptedWire([turnSnapshot()]);
	const request = wire.request;
	wire.request = (method, params, timeoutMs) => {
		if (method === "session.prompt") return Promise.reject(new Error("send refused"));
		return request(method, params, timeoutMs);
	};
	const turn = await driveTurn(wire, IDS, "ask");
	expect(turn.failure).toBe("send refused");
	expect(turn.elapsedMs).toBeLessThan(1_000);
	expect(wire.requests.some((request) => request.method === "session.abort")).toBe(true);
});

test("signals: skillRead + turnEnd; forbid wins over stop", async () => {
	const log = new EventLog();
	const watcher = watchSignals(
		log,
		[signals.skillRead("brainstorming")],
		[signals.skillRead("importing-a-codebase")],
	);
	for (const event of [
		...skillRead("a", "importing-a-codebase"),
		...skillRead("b", "brainstorming"),
	])
		log.push(event);
	const hit = await watcher.hit;
	expect(hit.kind).toBe("forbid");
	watcher.cancel();
});

const QUESTIONS: AskUserQuestionItem[] = [
	{
		question: "Which log format?",
		header: "Format",
		options: [
			{ label: "Plain text (Recommended)", description: "simple lines" },
			{ label: "JSON objects", description: "machine-readable" },
		],
	},
];

test("dialog: pickRecommended, skipAll, persona reply parsing", () => {
	const recommended = pickRecommended(QUESTIONS);
	expect(recommended.cancelled).toBe(false);
	expect(recommended.answers[0]?.answer).toBe("Plain text (Recommended)");
	expect(skipAll().cancelled).toBe(true);

	const ok = parsePersonaReply(
		'Sure: {"answers":[{"questionIndex":0,"answer":"JSON objects"}]}',
		QUESTIONS,
	);
	expect(ok?.answers[0]?.answer).toBe("JSON objects");
	expect(
		parsePersonaReply('{"answers":[{"questionIndex":0,"answer":"Nope"}]}', QUESTIONS),
	).toBeNull();
	expect(
		parsePersonaReply('{"answers":[{"questionIndex":9,"answer":"JSON objects"}]}', QUESTIONS),
	).toBeNull();
	expect(parsePersonaReply("not json at all", QUESTIONS)).toBeNull();
});

test("watchdog: budget tripwires + on-track parsing", () => {
	const log = routedLog();
	const now = Date.now();
	expect(checkBudget(log, now, DEFAULT_BUDGET, now)).toBeNull();
	expect(checkBudget(log, now, { ...DEFAULT_BUDGET, maxTurns: 1 }, now)).toContain("turns");
	expect(checkBudget(log, now, { ...DEFAULT_BUDGET, maxToolCalls: 2 }, now)).toContain(
		"tool calls",
	);
	expect(checkBudget(log, now - 10_000, { ...DEFAULT_BUDGET, maxMs: 5_000 }, now)).toContain(
		"wall time",
	);

	expect(parseOnTrackReply('{"onTrack": false, "reason": "looping"}')).toEqual({
		onTrack: false,
		reason: "looping",
	});
	expect(parseOnTrackReply("garbage").onTrack).toBe(true);
});

test("userSim + judge reply parsing", () => {
	expect(parseSimReply("DONE")).toBeNull();
	expect(parseSimReply("  done ")).toBeNull();
	expect(parseSimReply("Plain text please.")).toBe("Plain text please.");

	const rubric = ["named the route", "did not implement"];
	const parsed = parseJudgeReply(
		'[{"statement":"named the route","verdict":"pass","evidence":"quote"},{"statement":"did not implement","verdict":"fail","evidence":"edited foo.ts"}]',
		rubric,
	);
	expect(parsed.map((i) => i.verdict)).toEqual(["pass", "fail"]);
	expect(parseJudgeReply("no json here", rubric).every((i) => i.verdict === "unclear")).toBe(true);
});

test("presets: fixture snapshot filter drops only the .git directory", () => {
	expect(includeInFixtureSnapshot("/ws/.git")).toBe(false);
	expect(includeInFixtureSnapshot("/ws/.git/config")).toBe(false);
	expect(includeInFixtureSnapshot("/ws/.gitignore")).toBe(true);
	expect(includeInFixtureSnapshot("/ws/.github/workflows/ci.yml")).toBe(true);
	expect(includeInFixtureSnapshot("/ws/src/index.ts")).toBe(true);
});

test("presets: fixture markdown mask/unmask round-trip", () => {
	const dir = join(tmpdir(), `workflow-fixture-mask-${Date.now()}`);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "SPEC.md"), "---\nid: fixture-spec\ntype: module-design\n---\n");
	writeFileSync(join(dir, "src", "notes.md"), "plain");
	writeFileSync(join(dir, "src", "index.ts"), "export {};\n");

	maskFixtureMarkdown(dir);
	expect(existsSync(join(dir, "SPEC.md"))).toBe(false);
	expect(existsSync(join(dir, `SPEC.md${FIXTURE_MD_SUFFIX}`))).toBe(true);
	expect(existsSync(join(dir, "src", `notes.md${FIXTURE_MD_SUFFIX}`))).toBe(true);
	expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);

	unmaskFixtureMarkdown(dir);
	expect(existsSync(join(dir, `SPEC.md${FIXTURE_MD_SUFFIX}`))).toBe(false);
	expect(readFileSync(join(dir, "SPEC.md"), "utf8")).toContain("id: fixture-spec");
	expect(existsSync(join(dir, "src", "notes.md"))).toBe(true);
});

test("checks: skill ordering, tool discipline, files, spec frontmatter", () => {
	const cwd = join(tmpdir(), `workflow-harness-unit-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "TASK-x.md"), "---\nid: task-x\ntype: task-spec\n---\n\n## Request\n");
	writeFileSync(join(cwd, "notes.md"), "no frontmatter");
	const log = routedLog();
	log.push(toolStart("e1", "edit", { path: "/repo/src/main.ts" }));

	const results = runChecks(
		[
			checks.expectSkillRead("choosing-a-workflow"),
			checks.expectOrdering("choosing-a-workflow", "brainstorming"),
			checks.expectNoSkillRead(["importing-a-codebase"]),
			checks.expectToolCalled("edit"),
			checks.expectToolNotCalled("edit", { pathEndsWith: "TASK-x.md" }),
			checks.expectFile("TASK-x.md", /## Request/),
			checks.expectSpecValid("TASK-x.md"),
		],
		{ log, cwd },
	);
	expect(results.filter((r) => !r.pass)).toEqual([]);

	const failing = runChecks(
		[
			checks.expectOrdering("brainstorming", "choosing-a-workflow"),
			checks.expectSpecValid("notes.md"),
			checks.expectFile("missing.md"),
		],
		{ log, cwd },
	);
	expect(failing.every((r) => !r.pass)).toBe(true);
});

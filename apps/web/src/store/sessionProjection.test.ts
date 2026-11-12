import { beforeEach, expect, test } from "bun:test";
import type {
	AssistantMessage,
	ExtUiRequest,
	SessionEventPayload,
	SessionState,
	SessionSummary,
	UserMessage,
} from "@thinkrail/contracts";
import { messagesToRuntime } from "../chat/hydrate";
import { EMPTY_RUNTIME, reduceSessionEvent, useAppStore } from "./appStore";

const assistant = (text: string): AssistantMessage => ({
	id: "assistant-1",
	role: "assistant",
	content: [{ type: "text", text }],
	api: "responses",
	provider: "custom-go",
	model: "deepseek-v4.1-flash",
	timestamp: 1,
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const payload = (seq: number, text: string, sessionId = "session"): SessionEventPayload => ({
	sessionId,
	runId: "run",
	seq,
	event: { type: "message_end", message: assistant(text) },
});
const approval = (runId: string, revision: number): Extract<ExtUiRequest, { kind: "confirm" }> => ({
	id: "approval",
	sessionId: "session",
	runId,
	revision,
	toolCallId: "call",
	kind: "confirm",
	title: "Allow bash?",
	message: "echo approved",
});
const approvalSummary = (
	request: ReturnType<typeof approval>,
): SessionSummary & { state: SessionState } => ({
	sessionId: request.sessionId,
	workspaceId: "workspace",
	title: "Task",
	model: null,
	thinkingLevel: "off",
	isStreaming: true,
	messageCount: 0,
	updatedAt: 1,
	live: true,
	state: {
		execution: "running",
		runId: request.runId ?? null,
		needsInput: { interactionId: request.id, kind: "dialog", request },
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	},
});

beforeEach(() =>
	useAppStore.setState({
		sessions: {},
		sessionEventsBeforeHydration: {},
		tabsByWorkspace: {},
		removedWorkspaceIds: {},
		deletedSessionsByWorkspace: {},
		closedChatsByWorkspace: {},
		activeTabByWorkspace: {},
		sessionStateByWorkspace: {},
		extUiOrphans: [],
	}),
);

test("a final correction updates its stable message even after streaming ends", () => {
	let runtime = reduceSessionEvent(EMPTY_RUNTIME, {
		type: "message_start",
		message: assistant(""),
	});
	runtime = reduceSessionEvent(runtime, {
		type: "message_update",
		message: assistant("partial"),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "partial",
			partial: assistant("partial"),
		},
	});
	runtime = reduceSessionEvent(runtime, payload(1, "final").event);
	runtime = reduceSessionEvent(runtime, payload(2, "corrected final").event);
	expect(runtime.turns).toHaveLength(1);
	expect(runtime.turns[0]).toMatchObject({
		id: "assistant-1",
		streaming: false,
		message: assistant("corrected final"),
	});
	expect(messagesToRuntime([assistant("corrected final")]).turns[0]?.id).toBe("assistant-1");
});

test("a finalized user message reaches peers and replaces the optimistic ID", () => {
	const message: UserMessage = { id: "host-user", role: "user", content: "hello", timestamp: 1 };
	const peer = reduceSessionEvent(EMPTY_RUNTIME, { type: "message_end", message });
	expect(peer.turns).toEqual([{ kind: "user", id: "host-user", message }]);
	const sender = reduceSessionEvent(
		{
			...EMPTY_RUNTIME,
			turns: [
				{ kind: "user", id: "optimistic-user", message: { ...message, id: "optimistic-user" } },
			],
		},
		{ type: "message_end", message },
	);
	expect(sender.turns).toEqual(peer.turns);
});

test("initial hydration replays only events above the snapshot watermark", () => {
	const store = useAppStore.getState();
	store.beginSessionHydration("session");
	store.handleSessionEvents([payload(1, "included in snapshot"), payload(3, "after snapshot")]);
	const summary: SessionSummary = {
		sessionId: "session",
		workspaceId: "workspace",
		title: "Task",
		model: null,
		thinkingLevel: "off",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
		eventSeq: 2,
	};
	store.hydrateSession(summary, messagesToRuntime([assistant("snapshot")]));
	const runtime = useAppStore.getState().sessions.session;
	expect(runtime?.turns).toHaveLength(1);
	expect(runtime?.turns[0]).toMatchObject({ message: assistant("after snapshot") });
	expect(runtime?.lastEventSeq).toBe(3);
	expect(useAppStore.getState().sessionEventsBeforeHydration.session).toBeUndefined();
	store.handleSessionEvents([
		payload(3, "duplicate"),
		payload(2, "stale"),
		payload(4, "other", "other-session"),
	]);
	expect(useAppStore.getState().sessions.session).toBe(runtime);
});

test("closing a pending hydration clears its buffered events", () => {
	const store = useAppStore.getState();
	store.beginSessionHydration("session");
	store.handleSessionEvents([payload(1, "pending")]);
	store.closeChatRuntime("session");
	expect(useAppStore.getState().sessionEventsBeforeHydration.session).toBeUndefined();
});

test("fresh attachment and refresh recover approval from the transcript summary alone", () => {
	const store = useAppStore.getState();
	const request = approval("run", 4);
	const summary = approvalSummary(request);
	store.hydrateSession(summary, messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.closeChatRuntime("session");
	store.hydrateSession(summary, messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
});

test("an installed state restores approval on open and outranks a stale transcript summary", () => {
	const store = useAppStore.getState();
	const request = approval("new-run", 8);
	const summary = approvalSummary(request);
	const record = {
		sessionId: "session",
		workspaceId: "workspace",
		projectId: "project",
		state: summary.state,
	};
	store.installSessionStateSnapshot([record]);
	store.openChatSession("workspace", "session", null, "off");
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.closeChatRuntime("session");
	store.hydrateSession(approvalSummary(approval("old-run", 3)), messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	expect(useAppStore.getState().sessions.session?.hostState?.runId).toBe("new-run");
});

test("new ownership replaces an approval and a cleared request cannot return from stale snapshots or frames", () => {
	const store = useAppStore.getState();
	const oldRequest = approval("old-run", 3);
	store.hydrateSession(approvalSummary(oldRequest), messagesToRuntime([]));
	const request = approval("new-run", 8);
	const state = approvalSummary(request).state;
	const record = { sessionId: "session", workspaceId: "workspace", projectId: "project", state };
	store.applyExtUi(request);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(oldRequest);
	store.applySessionState(record);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.applyExtUi(oldRequest);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	expect(useAppStore.getState().sessions.session?.extUiQueue).toEqual([]);
	store.applySessionState({ ...record, state: { ...state, needsInput: null } });
	const revision = useAppStore.getState().sessions.session?.eventRevision;
	if (revision === undefined) throw new Error("Missing session runtime");
	expect(store.reconcileSession(approvalSummary(request), messagesToRuntime([]), revision, 0)).toBe(
		true,
	);
	store.applyExtUi(oldRequest);
	store.applyExtUi(request);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toBeNull();
	expect(useAppStore.getState().sessions.session?.hostState?.needsInput).toBeNull();
});

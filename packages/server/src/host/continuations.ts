import { randomUUID } from "node:crypto";
import type {
	ChatContinuation,
	ChatHandoffDetails,
	ContinueInWorkspaceRequestDetails,
	Project,
	SessionEvent,
	Workspace,
} from "@thinkrail/contracts";
import {
	CHAT_HANDOFF_CUSTOM_TYPE,
	CHAT_HANDOFF_SUMMARY_MAX_LENGTH,
	CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	type ContinueToolHost,
	ensureSessionAttached,
	getSessionState,
	getSessionWorkspaceId,
	isHostMessagePending,
	listSessions,
	sendHostMessageToSession,
} from "../agent";
import { listProjects } from "../projects";
import {
	chatWorkspaces,
	createWorkspaceWithChat,
	getChatWorkspace,
	getWorkspace,
	isChatsContainer,
	recordChatContinuation,
} from "../workspaces";
import { startChatSession } from "./chatSession";
import { assertChatOpen } from "./chats";

interface Operation {
	state: ChatContinuation;
	sourceTitle?: string;
	request: ContinueInWorkspaceRequestDetails;
	applying?: Promise<string>;
}

const operations = new Map<string, Operation>();
const bySource = new Map<string, string>();
const admissions = new Map<string, { projectId: string; done: Promise<{ operationId: string }> }>();
let publish: ((continuation: ChatContinuation) => void) | null = null;

export function setContinuationPublisher(next: typeof publish): void {
	publish = next;
}

function emit(operation: Operation, patch: Partial<ChatContinuation>): ChatContinuation {
	operation.state = { ...operation.state, ...patch };
	publish?.(operation.state);
	return operation.state;
}

function fail(operation: Operation, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	const leftover = projectWorkspace(operation.state.workspaceId, operation.state.projectId);
	emit(operation, {
		phase: "failed",
		reason: leftover
			? `${reason} Workspace "${leftover.name}" (${leftover.id}) already exists; retry will reuse it.`
			: reason,
	});
}

function boundTo(sessionId: string): Operation | undefined {
	const operationId = bySource.get(sessionId);
	return operationId ? operations.get(operationId) : undefined;
}

function inFlight({ state }: Operation): boolean {
	return state.phase === "requested" || state.phase === "summarizing" || state.phase === "creating";
}

function continuingElsewhere(projectId: string): CodedError {
	const name =
		listProjects().find((project) => project.id === projectId)?.name ?? "another project";
	return new CodedError(
		"CONTINUATION_IN_FLIGHT",
		`This chat is already being continued in ${name}.`,
	);
}

function openRepository(projectId: string): Project | null {
	const project = listProjects().find((candidate) => candidate.id === projectId);
	return project && !isChatsContainer(project) ? project : null;
}

function projectWorkspace(workspaceId: string | undefined, projectId: string): Workspace | null {
	if (!workspaceId) return null;
	try {
		const workspace = getWorkspace(workspaceId);
		return workspace.projectId === projectId ? workspace : null;
	} catch {
		return null;
	}
}

function requestText(project: Project): string {
	return [
		`RailDesign: the user asked to continue this conversation in a new workspace of the project "${project.name}".`,
		"Write a short handoff summary for the agent that will pick it up there — what was asked, what was decided, what is still open, anything it must know — then call `continue_in_workspace` with that summary. Do not do anything else in this turn.",
	].join("\n\n");
}

function handoffText(details: ChatHandoffDetails): string {
	return [
		'<handoff source="raildesign-chat">',
		`This chat continues a chat without a project${details.sourceTitle ? ` (“${details.sourceTitle}”)` : ""}. The summary its agent wrote:`,
		"",
		details.summary,
		"",
		"Treat it as the brief; the files of the earlier chat were not copied. Continue the work here.",
		"</handoff>",
	].join("\n");
}

export function startContinuation(
	sourceWorkspaceId: string,
	projectId: string,
): Promise<{ operationId: string }> {
	const admitting = admissions.get(sourceWorkspaceId);
	if (admitting) {
		return admitting.projectId === projectId
			? admitting.done
			: Promise.reject(continuingElsewhere(admitting.projectId));
	}
	const done = admitContinuation(sourceWorkspaceId, projectId).finally(() => {
		if (admissions.get(sourceWorkspaceId)?.done === done) admissions.delete(sourceWorkspaceId);
	});
	admissions.set(sourceWorkspaceId, { projectId, done });
	return done;
}

async function admitContinuation(
	sourceWorkspaceId: string,
	projectId: string,
): Promise<{ operationId: string }> {
	const source = getChatWorkspace(sourceWorkspaceId);
	assertChatOpen(source.id);
	const project = openRepository(projectId);
	if (!project) throw new CodedError("CHATS_CONTAINER", "Pick an open project to continue in.");
	const summary = (await listSessions(source.id, source.worktreePath))[0];
	assertChatOpen(source.id);
	if (!summary || summary.messageCount === 0) {
		throw new CodedError("NOT_A_CHAT", "This chat has no conversation to continue.");
	}
	const sourceSessionId = summary.sessionId;
	const previous = boundTo(sourceSessionId);
	if (previous && inFlight(previous)) {
		if (previous.state.projectId !== project.id)
			throw continuingElsewhere(previous.state.projectId);
		return { operationId: previous.state.operationId };
	}
	if (!(await ensureSessionAttached(sourceSessionId, source.id, source.worktreePath))) {
		throw new CodedError("NOT_A_CHAT", "This chat's conversation could not be opened.");
	}
	assertChatOpen(source.id);
	if (getSessionWorkspaceId(sourceSessionId) !== source.id)
		throw new CodedError("NOT_A_CHAT", "This conversation belongs to another workspace.");
	const leftover =
		previous?.state.phase === "failed" && previous.state.projectId === project.id
			? projectWorkspace(previous.state.workspaceId, project.id)
			: null;
	const operationId = randomUUID();
	const operation: Operation = {
		state: {
			operationId,
			sourceWorkspaceId: source.id,
			sourceSessionId,
			projectId: project.id,
			phase: "requested",
			...(leftover ? { workspaceId: leftover.id } : {}),
		},
		request: { operationId, projectId: project.id, projectName: project.name },
		...(summary.title ? { sourceTitle: summary.title } : {}),
	};
	operations.set(operationId, operation);
	bySource.set(sourceSessionId, operationId);
	publish?.(operation.state);
	emit(operation, { phase: "summarizing" });
	try {
		await sendHostMessageToSession(
			sourceSessionId,
			CONTINUE_IN_WORKSPACE_REQUEST_CUSTOM_TYPE,
			requestText(project),
			operation.request,
		);
	} catch (error) {
		fail(operation, error);
		throw error;
	}
	return { operationId };
}

export async function continuationStatus(operationId: string): Promise<ChatContinuation> {
	const operation = operations.get(operationId);
	if (operation) return operation.state;
	for (const chat of chatWorkspaces()) {
		const link = chat.continuedTo?.find((candidate) => candidate.operationId === operationId);
		if (!link) continue;
		const source = (await listSessions(chat.id, chat.worktreePath))[0];
		return {
			operationId,
			sourceWorkspaceId: chat.id,
			sourceSessionId: source?.sessionId ?? "",
			projectId: link.projectId,
			workspaceId: link.workspaceId,
			sessionId: link.sessionId,
			phase: "started",
		};
	}
	throw new CodedError("CONTINUATION_UNKNOWN", "The host no longer knows this continuation.");
}

export function applyContinuation(
	sessionId: string,
	summary: string,
	signal: AbortSignal,
	assertActive: () => void,
	inputId: string | undefined,
): Promise<string> {
	const operation = boundTo(sessionId);
	const phase = operation?.state.phase;
	if (!operation || (phase !== "summarizing" && phase !== "creating" && phase !== "started")) {
		return Promise.reject(
			new Error("No continuation is pending for this chat. Ask to continue in a workspace again."),
		);
	}
	if (inputId !== `host-input-${operation.state.operationId}`)
		return Promise.reject(
			new Error("This summary request is stale. Use the current continuation request."),
		);
	const trimmed = summary.trim();
	if (!trimmed || trimmed.length > CHAT_HANDOFF_SUMMARY_MAX_LENGTH)
		return Promise.reject(new Error("Pass a non-empty, bounded handoff summary."));
	operation.applying ??= runContinuation(operation, trimmed, signal, assertActive).catch(
		(error) => {
			fail(operation, error);
			throw error;
		},
	);
	return operation.applying;
}

async function runContinuation(
	operation: Operation,
	summary: string,
	signal: AbortSignal,
	assertActive: () => void,
): Promise<string> {
	const { operationId, projectId, sourceWorkspaceId, sourceSessionId } = operation.state;
	const assertCurrent = () => {
		signal.throwIfAborted();
		assertActive();
		assertChatOpen(sourceWorkspaceId);
		if (getSessionWorkspaceId(sourceSessionId) !== sourceWorkspaceId)
			throw new Error("The source conversation is no longer available.");
		if (!openRepository(projectId)) throw new Error("The project is no longer open.");
	};
	assertCurrent();
	emit(operation, { phase: "creating" });
	let workspace = projectWorkspace(operation.state.workspaceId, projectId);
	if (!workspace) {
		workspace = (await createWorkspaceWithChat(projectId, {}, signal)).workspace;
		emit(operation, { workspaceId: workspace.id });
	}
	assertCurrent();
	const { sessionId: targetSessionId } = await startChatSession(
		workspace,
		{},
		{
			assertClaimed: assertCurrent,
		},
	);
	assertCurrent();
	emit(operation, { sessionId: targetSessionId });
	const details: ChatHandoffDetails = {
		operationId,
		sourceWorkspaceId,
		sourceSessionId,
		...(operation.sourceTitle ? { sourceTitle: operation.sourceTitle } : {}),
		summary,
	};
	recordChatContinuation(sourceWorkspaceId, {
		operationId,
		projectId,
		workspaceId: workspace.id,
		sessionId: targetSessionId,
	});
	let firstMessage: "sent" | "failed" = "sent";
	try {
		await sendHostMessageToSession(
			targetSessionId,
			CHAT_HANDOFF_CUSTOM_TYPE,
			handoffText(details),
			details,
		);
	} catch {
		firstMessage = "failed";
	}
	emit(operation, { phase: "started", firstMessage });
	const project = openRepository(projectId);
	return `Continued in workspace "${workspace.name}" of ${project?.name ?? projectId} (workspace ${workspace.id}, chat ${targetSessionId}); the handoff ${firstMessage === "sent" ? "was delivered" : "could not be delivered"}.`;
}

export function observeContinuation(sessionId: string, event: SessionEvent): void {
	if (event.type !== "agent_settled" && event.type !== "queue_update") return;
	const operation = boundTo(sessionId);
	if (operation?.state.phase !== "summarizing") return;
	if (isHostMessagePending(sessionId, operation.request)) return;
	if (event.type === "queue_update" && getSessionState(sessionId).execution !== "idle") return;
	fail(
		operation,
		new Error(
			event.type === "queue_update"
				? "The request left the chat's queue before the agent answered it."
				: "The agent finished without a summary.",
		),
	);
}

export const continueToolHost: ContinueToolHost = { apply: applyContinuation };

export function clearContinuations(): void {
	operations.clear();
	bySource.clear();
	admissions.clear();
}

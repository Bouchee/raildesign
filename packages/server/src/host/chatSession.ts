import type { Workspace } from "@thinkrail/contracts";
import {
	type CreateSessionResult,
	createSession,
	deleteSession,
	getSessionState,
	isSessionStreaming,
	readSessionRecord,
} from "../agent";
import { logger } from "../log";
import { ensureWorkspaceScratchDir } from "../workspaces";
import { type NewChatModelRequest, noteNewChat, resolveNewChatModel } from "./newChatModel";

const log = logger("host");

export interface ChatStartOptions {
	readonly pick?: boolean;
	readonly assertClaimed?: () => void;
}

export async function startChatSession(
	workspace: Workspace,
	requested: NewChatModelRequest,
	{ pick = false, assertClaimed = () => {} }: ChatStartOptions = {},
): Promise<CreateSessionResult> {
	const defaults = await resolveNewChatModel(requested);
	assertClaimed();
	ensureWorkspaceScratchDir(workspace);
	let created: CreateSessionResult;
	try {
		created = await createSession({
			cwd: workspace.worktreePath,
			workspaceId: workspace.id,
			...(defaults.model ? { model: defaults.model } : {}),
			thinkingLevel: defaults.thinkingLevel,
		});
	} catch (error) {
		assertClaimed();
		throw error;
	}
	try {
		assertClaimed();
	} catch (error) {
		try {
			const record = readSessionRecord(created.sessionId);
			if (
				record?.messages.length === 0 &&
				record.queue.length === 0 &&
				!isSessionStreaming(created.sessionId) &&
				getSessionState(created.sessionId).execution === "idle"
			)
				await deleteSession(created.sessionId, workspace.id, workspace.worktreePath);
		} catch (cleanupError) {
			log.warn(
				"could not remove an unused chat after its creation claim was revoked",
				cleanupError,
			);
		}
		throw error;
	}
	noteNewChat(pick ? requested : {}, defaults, created);
	return created;
}

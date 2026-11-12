import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
	OpenBranchReview,
	ReviewComment,
	ReviewSendResult,
	TemplateReadLocation,
	ThinkingLevel,
	WireModel,
	Workspace,
	WsMethodName,
	WsParams,
	WsResult,
} from "@thinkrail/contracts";
import {
	BRANCH_STATUS_PROTOCOL_VERSION,
	isSpeechModel,
	WORKSPACE_SETTLE_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import { z } from "zod";
import {
	abortSession,
	acknowledgeCompletion,
	admissionContextFor,
	cancelMcpProbe,
	cancelMcpProbesForWorkspace,
	clampThinkingForModel,
	clearSessionQueue,
	closeWorkspaceMcpConnections,
	compactSession,
	deleteSession,
	ensureSessionAttached,
	followUpSession,
	getSessionMessages,
	getSessionStats,
	isMcpLoginId,
	listAvailableModels,
	listCustomEndpoints,
	listProjectAliasSkillNames,
	listSessionStates,
	listSessions,
	listSkillCatalog,
	listSkillCommands,
	markWorkspaceRead,
	markWorkspaceUnread,
	notifyExtUi,
	probeCustomEndpoint,
	projectTrustSummary,
	promptSession,
	readSessionRecord,
	refreshAvailableModels,
	reloadSessionResources,
	removeCustomEndpoint,
	removeQueuedMessage,
	removeSession,
	removeWorkspaceSessions,
	renameSession,
	replyMcpProbe,
	resolveExtUi,
	respondToTool,
	saveCustomEndpoint,
	sendSteeringNow,
	setSessionModel,
	setSessionThinkingLevel,
	steerSession,
	updateQueuedMessage,
} from "../agent";

import { suggestPrDescription } from "../assist";
import { getProviderStatus } from "../auth";

import { providerFromRemoteUrl } from "../branch-review";
import { forgetWorkspaceChanges, revertChange, undoChange } from "../changes";
import { selectDirectory } from "../dialog";
import { listAvailableEditors, openEditor, revealInFileManager } from "../editors";
import { hostEnvironmentStatus, updateHostEnvironment } from "../environment";
import { listExtensionCatalog } from "../extensions";

import { fontsDir, listInstalledFonts, readUserFonts } from "../fonts";
import { readDir, readFile } from "../fs";
import {
	commitsAheadOf,
	countPushDivergence,
	countPushTargetDivergence,
	gitDiffFile,
	gitStatus,
	ignoredPaths,
	listBranches,
	listCommits,
	originUrls,
	type PushTargetStatus,
	prefetchBranch,
	remoteRefOidAsync,
} from "../git";
import { githubAuthStatus, githubRefresh } from "../github";
import { clampLimit, getHistoryIndex } from "../history";
import { localesDir, readLocalLocales } from "../locales";
import { logger } from "../log";
import {
	deleteRemoteBranch,
	mergePr,
	onBaseBranch,
	openPr,
	prDraftInput,
	previewPr,
	pushBranch,
	readyPr,
	reopenPr,
} from "../pr";
import {
	acknowledgeProjectSkills,
	cancelProjectClone,
	closeProject,
	createProject,
	initProject,
	inspectCloneDestination,
	inspectProjectPath,
	listProjects,
	openProject,
	renameProject,
	setProjectGroupEnabled,
	setProjectSkillEnabled,
	setProjectTrust,
	startProjectClone,
} from "../projects";
import {
	addComment,
	buildSendPackage,
	clearReview,
	deleteComment,
	fileReviewSession,
	getReviewSnapshot,
	markCommentsSent,
	markFileDone,
	REVIEW_LEVEL_KEY,
	removeWorkspaceReviews,
	reviewSessionKey,
	rollbackSend,
	sendableComments,
	updateComment,
} from "../reviews";
import { getConfig, noteRecentModel, updateConfig } from "../settings";
import { evictSpecIndex, evictSpecRoot, projectHasSpecs, specGraph } from "../spec";
import { cancelSpeechInstall, installSpeech, removeSpeech } from "../speech";
import {
	deleteTemplate,
	getTemplate,
	listTemplates,
	saveTemplate,
	templateDirs,
} from "../templates";
import {
	attachTerminal,
	closeTerminalTab,
	closeWorkspaceTerminals,
	listTerminals,
	reserveTerminal,
	resizeTerminal,
	writeTerminal,
} from "../terminal";
import { readUserThemes, themesDir } from "../themes";
import {
	addTodo,
	approveTodoReview,
	countOpenTodos,
	generateTodoSummary,
	listTodos,
	removeSessionTodoWindows,
	removeTodo,
	settleChangeArtifacts,
	updateTodo,
} from "../todos";
import { forgetWorkspaceTurns, listTurns } from "../turns";
import { ensureWatch, stopWatch } from "../watch";
import {
	assertNotChatsContainer,
	assertNotChatWorkspace,
	awaitWorkspaceCreation,
	type CreationHandoff,
	createWorkspace,
	dismissWorkspaceCreation,
	forgetWorkspace,
	getWorkspace,
	isChatsContainer,
	isChatsContainerId,
	isChatWorkspace,
	isChatWorkspaceId,
	listAllWorkspaceRecords,
	listExistingWorktrees,
	listWorkspaceCreations,
	listWorkspaceRecords,
	listWorkspaces,
	openExistingWorktree,
	reclaimWorktree,
	recordWorkspaceActivity,
	renameWorkspace,
	retryWorkspaceCreation,
	settleWorkspace,
	setWorkspaceDiffBase,
	setWorkspaceReview,
	setWorkspaceSkillOverride,
	setWorkspaceSubagentMaxConcurrent,
	setWorkspaceSubagentsOverride,
	startWorkspaceCreation,
	unsettleWorkspace,
	workspaceDiffStats,
} from "../workspaces";
import { ackSend } from "./ackSend";
import { startChatSession } from "./chatSession";
import {
	assertChatOpen,
	assertSessionDeletable,
	createChat,
	deleteChat,
	historyHiddenCwd,
	inspectChat,
	recoverChatSession,
	seesChats,
} from "./chats";
import { nudgeBaseRefWorkspaces } from "./fsNudge";
import { buildHistoryScope } from "./historyScope";
import { provisionInitialTerminal } from "./initialTerminal";
import {
	mcpAdd,
	mcpApprove,
	mcpList,
	mcpLogin,
	mcpLogout,
	mcpReadLog,
	mcpReadOutput,
	mcpReconnect,
	mcpRemove,
	mcpRevokeToolGrant,
	mcpSetProjectOverride,
	mcpSetSessionOverride,
	mcpShareWithRepo,
	mcpTestConnection,
	mcpUpdate,
	reloadLiveSessions,
} from "./mcp";
import { resolveNewChatModel } from "./newChatModel";
import { withChangeLock, withReviewLock } from "./reviewLock";
import { hostSearch, publishSearchText } from "./search";
import { findWorkspaceReviewOutcome, scheduleLifecyclePass } from "./settledLifecycle";
import {
	clearChangesRequestedIfResolved,
	isItemUnderActiveReview,
	markClientStale,
} from "./todoReview";
import { configureWebAccess, webAccessStatus } from "./webAccess";

const log = logger("host");
const clientErrorSchema = z
	.object({
		kind: z.enum(["render", "window", "rejection"]),
		type: z.string().min(1).max(120),
		stack: z.string().max(16_384).optional(),
		boundary: z.string().max(120).optional(),
	})
	.strict();
const CLIENT_ERROR_TYPES = new Set([
	"Error",
	"TypeError",
	"SyntaxError",
	"RangeError",
	"ReferenceError",
	"URIError",
	"EvalError",
	"UnhandledRejection",
]);

export interface RequestContext {
	clientKey: string;
	/** The socket's advertised protocol; absent for in-process callers, who speak the current one. */
	protocolVersion?: number;
	runHostUpdate?: () => void;
}

type WsHandler<M extends WsMethodName> = (
	params: WsParams<M>,
	ctx: RequestContext,
) => WsResult<M> | Promise<WsResult<M>>;

type WsHandlers = { [M in WsMethodName]?: WsHandler<M> };

async function archiveTeardown(ws: Workspace): Promise<void> {
	try {
		await removeWorkspaceSessions(ws.id, ws.worktreePath);
		await settleChangeArtifacts(ws.id);
		await reclaimWorktree(ws);
	} catch {
		log.warn(`workspace archive teardown failed for ${ws.id}`);
	}
}

async function sendUserMessage(operation: () => Promise<void>): Promise<{ ok: true }> {
	await ackSend(operation());
	return { ok: true };
}

const sessionInputSchema = z.object({
	sessionId: z.string().min(1),
	text: z.string(),
	messageId: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,200}$/)
		.optional(),
	images: z
		.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }))
		.optional(),
});

export const workspaceCreationHandoff: CreationHandoff = async (workspace, kickoff) => {
	provisionInitialTerminal(workspace);
	if (!kickoff) return {};
	await ensureWatch(workspace.id, { prewarm: false });
	const chat = await startChatSession(workspace, kickoff, { pick: true });
	if (!kickoff.text && !kickoff.images?.length) return chat;
	try {
		void promptSession(chat.sessionId, kickoff.text, kickoff.images).catch((error) =>
			log.warn("workspace kickoff failed", error),
		);
		return chat;
	} catch (error) {
		return { ...chat, kickoffError: error instanceof Error ? error.message : String(error) };
	}
};

async function attachInteractionSession(sessionId: string): Promise<void> {
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Unknown session");
	const workspace = getWorkspace(record.workspaceId);
	if (
		resolve(record.cwd) !== resolve(workspace.worktreePath) ||
		!(await ensureSessionAttached(sessionId, workspace.id, workspace.worktreePath))
	)
		throw new Error("Session is unavailable in its workspace");
}

function revealDataFolder(dir: string) {
	mkdirSync(dir, { recursive: true });
	revealInFileManager(dir);
	return { ok: true } as const;
}

function resolveTemplateReadDirs(params: TemplateReadLocation) {
	const { workspaceId, projectId } = params;
	if (workspaceId !== undefined && projectId !== undefined) {
		throw new Error("Template reads accept either workspaceId or projectId, not both");
	}
	if (workspaceId !== undefined) return templateDirs(getWorkspace(workspaceId).worktreePath);
	if (projectId === undefined) return templateDirs();
	const project = listProjects().find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Unknown project: ${projectId}`);
	return templateDirs(project.path);
}

function fireReviewPrompt(
	workspaceId: string,
	comments: readonly ReviewComment[],
	sessionId: string,
	pkg: string,
	send: (sessionId: string, text: string) => Promise<void> = promptSession,
): void {
	const ids = comments.map((c) => c.id);
	void ackSend(send(sessionId, pkg))
		.catch((err) => {
			rollbackSend(workspaceId, ids, sessionId);
			notifyExtUi(
				sessionId,
				`Review send failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		})
		.catch(() => {
			log.warn("review send rollback failed");
		});
}

function reviewSendGroups(
	comments: ReviewComment[],
	sessionId: string | undefined,
): ReviewComment[][] {
	if (comments.length === 0) return [];
	if (sessionId) return [comments];
	const groups = new Map<string, ReviewComment[]>();
	for (const comment of comments) {
		const key = reviewSessionKey(comment);
		groups.set(key, [...(groups.get(key) ?? []), comment]);
	}
	return [...groups.values()];
}

async function sendToFileChat(
	workspaceId: string,
	comments: ReviewComment[],
	opts: { model?: WireModel; thinkingLevel?: ThinkingLevel; sessionId?: string },
): Promise<ReviewSendResult> {
	const ids = comments.map((c) => c.id);
	const pkg = await buildSendPackage(workspaceId, comments);
	const ws = getWorkspace(workspaceId);
	const first = comments[0];
	const path = first ? reviewSessionKey(first) : REVIEW_LEVEL_KEY;
	const existing = opts.sessionId ?? (await fileReviewSession(workspaceId, path));
	if (existing && (await ensureSessionAttached(existing, workspaceId, ws.worktreePath))) {
		await markCommentsSent(workspaceId, ids, existing);
		fireReviewPrompt(workspaceId, comments, existing, pkg);
		return {
			sessionId: existing,
			model: null,
			thinkingLevel: "medium",
			reused: true,
		};
	}
	if (existing) {
		log.warn(
			`review ${workspaceId}: linked chat ${existing} is no longer on disk — starting a new review chat`,
		);
	}
	const created = await startChatSession(ws, opts);
	await markCommentsSent(workspaceId, ids, created.sessionId);
	fireReviewPrompt(workspaceId, comments, created.sessionId, pkg);
	return { ...created, reused: false };
}

function sessionStateWorkspace(workspace: Workspace) {
	return { id: workspace.id, projectId: workspace.projectId, cwd: workspace.worktreePath };
}

function repositoryProject(projectId: string) {
	const project = listProjects().find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Unknown project: ${projectId}`);
	assertNotChatsContainer(project);
	return project;
}

function repositoryWorkspace(workspaceId: string, action: string): Workspace {
	const workspace = getWorkspace(workspaceId);
	assertNotChatWorkspace(workspace, action);
	return workspace;
}

const handlers: WsHandlers = {
	"client.reportError": (params) => {
		const report = clientErrorSchema.parse(params);
		const type = CLIENT_ERROR_TYPES.has(report.type) ? report.type : "Error";
		log.warn(`client ${report.kind} error (${type})`);
		return { ok: true };
	},
	"project.open": (params) => (() => openProject(params.path))(),
	"project.inspect": (params) => inspectProjectPath(params.path),
	"project.init": (params) => (() => initProject(params.path))(),
	"project.create": (params) =>
		(() => createProject(params.parentPath, params.name, params.displayName))(),
	"project.cloneDestination": (params) => ({
		path: inspectCloneDestination(params.parentPath, params.name),
	}),
	"project.clone": (params, ctx) => startProjectClone(params, ctx.clientKey),
	"project.cancelClone": (params, ctx) => {
		cancelProjectClone(params.operationId, ctx.clientKey);
		return { ok: true };
	},
	"project.list": (_params, ctx) =>
		(() =>
			listProjects().filter(
				(project) => seesChats(ctx.protocolVersion) || !isChatsContainer(project),
			))(),
	"project.hasSpecs": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		return { hasSpecs: project ? projectHasSpecs(project.path) : false };
	},
	"project.close": async (params) => {
		repositoryProject(params.id);
		await Promise.all(
			listWorkspaceRecords(params.id).map(async (workspace) => {
				await cancelMcpProbesForWorkspace(workspace.id);
				await closeWorkspaceMcpConnections(workspace.id);
			}),
		);
		closeProject(params.id);
		return { ok: true } as const;
	},
	"project.rename": (params) => {
		repositoryProject(params.id);
		return renameProject(params.id, params.name);
	},

	"project.setTrust": async (p) => {
		const input = z
			.object({ id: z.string(), trusted: z.boolean(), resources: z.boolean().optional() })
			.parse(p);
		const project = repositoryProject(input.id);
		const acknowledged =
			input.trusted && project.trusted !== true
				? await listProjectAliasSkillNames(project.path)
				: undefined;
		const updated = setProjectTrust(input.id, input.trusted, acknowledged, {
			resources: input.resources === true,
		});
		await reloadLiveSessions(listWorkspaceRecords(input.id).map((workspace) => workspace.id));
		return updated;
	},
	"workspace.create": (p) => (() => createWorkspace(p.projectId, p.name, p.baseRef))(),
	"workspace.startCreate": (p) => {
		const creation = startWorkspaceCreation(p.projectId, {
			...(p.name ? { name: p.name } : {}),
			...(p.baseRef ? { baseRef: p.baseRef } : {}),
			...(p.kickoff ? { kickoff: p.kickoff } : {}),
		});
		void (() => awaitWorkspaceCreation(creation.id))().catch(() => {});
		return creation;
	},
	"workspace.listCreations": () => listWorkspaceCreations(),
	"workspace.retryCreation": (p) => {
		const creation = retryWorkspaceCreation(p.id);
		return creation;
	},
	"workspace.dismissCreation": async (p) => {
		const dismissed = await dismissWorkspaceCreation(p.id);
		return dismissed;
	},
	"workspace.listExisting": (params) => {
		repositoryProject(params.projectId);
		return listExistingWorktrees(params.projectId);
	},
	"workspace.openExisting": async (p) => {
		return provisionInitialTerminal(await (() => openExistingWorktree(p.projectId, p.path))());
	},
	"workspace.rename": (p) => {
		return renameWorkspace(p.id, p.name).workspace;
	},
	"workspace.list": async (p, ctx) => {
		if (!seesChats(ctx.protocolVersion) && isChatsContainerId(p.projectId)) return [];
		const rows = (
			await listWorkspaces(p.projectId, { includeDiffStats: p.includeDiffStats ?? true })
		).map((workspace) => ({ ...workspace, ...provisionInitialTerminal(workspace) }));
		void scheduleLifecyclePass(p.projectId).catch(() =>
			log.warn(`settled lifecycle pass failed for project ${p.projectId}`),
		);
		return rows;
	},
	"workspace.openReview": async (p, ctx) => {
		const ws = repositoryWorkspace(p.workspaceId, "reviewed");
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const [outcome, divergence] = await Promise.all([
			findWorkspaceReviewOutcome(ws, { fresh }),
			// Only pay the network fetch on a fresh lookup (focus / explicit refresh), not a cached activation.
			countPushDivergence(ws.worktreePath, ws.branch, { fetch: fresh }),
		]);
		if (outcome.reliable) setWorkspaceReview(ws.id, outcome.value, ws.branch);
		const review = openReviewForClient(outcome.value, ctx.protocolVersion);
		if (!review) return review;
		const { details: _details, ...reference } = review;
		return {
			...reference,
			...(divergence && divergence.ahead > 0 ? { unpushedCommits: divergence.ahead } : {}),
			...(divergence && divergence.behind > 0 ? { behindCommits: divergence.behind } : {}),
		};
	},
	"workspace.branchStatus": async (p, ctx) => {
		const ws = repositoryWorkspace(p.workspaceId, "given a branch status");
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const origin = await originUrls(ws.worktreePath);
		const splitPushUrl = origin.push !== origin.fetch ? origin.push : null;
		const [outcome, measured, aheadOfBase] = await Promise.all([
			findWorkspaceReviewOutcome(ws, { fresh }),
			(splitPushUrl
				? countPushTargetDivergence(ws.worktreePath, ws.branch, splitPushUrl)
				: countPushDivergence(ws.worktreePath, ws.branch, {
						fetch: fresh && p.skipFetch !== true,
					}).then(
						(divergence): PushTargetStatus =>
							divergence ? { published: true, ...divergence } : { published: false },
					)
			).catch(() => undefined),
			commitsAheadOf(ws.worktreePath, ws.baseBranch),
		]);
		if (outcome.reliable) setWorkspaceReview(ws.id, outcome.value, ws.branch);
		return {
			hasOrigin: origin.push !== null,
			provider: origin.push ? providerFromRemoteUrl(origin.push) : null,
			pushesElsewhere: splitPushUrl !== null,
			published:
				measured?.published ??
				(splitPushUrl
					? null
					: (await remoteRefOidAsync(ws.worktreePath, `origin/${ws.branch}`)) !== null),
			...(measured?.published && measured.ahead !== undefined && measured.behind !== undefined
				? { ahead: measured.ahead, behind: measured.behind }
				: {}),
			aheadOfBase,
			onBase: onBaseBranch(ws),
			review: openReviewForClient(outcome.value, ctx.protocolVersion),
		};
	},
	"workspace.push": async (p) => {
		repositoryWorkspace(p.workspaceId, "pushed");
		recordWorkspaceActivity(p.workspaceId);
		return pushBranch(p);
	},
	"workspace.deleteRemoteBranch": async (p) => {
		repositoryWorkspace(p.workspaceId, "pushed");
		recordWorkspaceActivity(p.workspaceId);
		await deleteRemoteBranch(p);
		return { ok: true } as const;
	},
	"workspace.settle": (params) => settleWorkspace(params.id),
	"workspace.unsettle": (params) => unsettleWorkspace(params.id),
	"workspace.markUnread": async (params) => ({
		record: await markWorkspaceUnread(sessionStateWorkspace(getWorkspace(params.id))),
	}),
	"workspace.markRead": async (params) => ({
		records: await markWorkspaceRead(sessionStateWorkspace(getWorkspace(params.id))),
	}),
	"workspace.remove": async (params) => {
		const id = params.id;
		await cancelMcpProbesForWorkspace(id);
		await closeWorkspaceMcpConnections(id);
		const ws = forgetWorkspace(id);
		if (ws) {
			evictSpecIndex(ws.id);
			evictSpecRoot(ws.worktreePath);
			removeWorkspaceReviews(ws.id);
			forgetWorkspaceChanges(ws.id);
			forgetWorkspaceTurns(ws.id);
			stopWatch(ws.id);
			closeWorkspaceTerminals(ws.id);
			void archiveTeardown(ws);
		}
		return { ok: true } as const;
	},
	"workspace.diffStats": (params) => workspaceDiffStats(params.id),
	"chat.create": (params) => createChat(params),
	"chat.delete": async (params) => {
		await deleteChat(params.workspaceId);
		return { ok: true } as const;
	},
	"chat.inspect": (params) => inspectChat(params.workspaceId),
	"workspace.openIn": async (p) => {
		await openEditor(p.editor, getWorkspace(p.id).worktreePath);
		return { ok: true } as const;
	},
	"workspace.reveal": (params) => {
		revealInFileManager(getWorkspace(params.id).worktreePath);
		return { ok: true } as const;
	},
	"editor.list": () => listAvailableEditors(),
	"git.listBranches": (params) => {
		repositoryProject(params.projectId);
		return listBranches(params.projectId);
	},
	"git.prefetch": async (p) => {
		repositoryProject(p.projectId);
		const { ok, moved } = await prefetchBranch(p.projectId, p.ref);
		if (moved) nudgeBaseRefWorkspaces(p.projectId, p.ref);
		return { ok };
	},
	"github.authStatus": () => githubAuthStatus(),
	"github.refresh": () => githubRefresh(),
	"pr.preview": (params, ctx) =>
		previewPr(
			params.sessionId && !params.source && !supportsBranchStatus(ctx.protocolVersion)
				? { ...params, source: "plan" }
				: params,
		),
	"pr.generate": async (params) => ({
		body: await suggestPrDescription(await prDraftInput(params)),
	}),
	"pr.ready": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		await readyPr(p);
		return { ok: true } as const;
	},
	"pr.merge": (p) => {
		recordWorkspaceActivity(p.workspaceId);
		return mergePr(p);
	},
	"pr.reopen": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		await reopenPr(p);
		return { ok: true } as const;
	},
	"pr.open": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		const { branch, ...result } = await (() => openPr(p))();
		if (result.review) {
			setWorkspaceReview(
				p.workspaceId,
				{
					...result.review,
					state: "open",
					...(result.url ? { url: result.url } : {}),
				},
				branch,
			);
		}
		return result;
	},
	"dialog.selectDirectory": () => selectDirectory(),
	"fs.readDir": async (p) => {
		void ensureWatch(p.workspaceId);
		const nodes = readDir(p.workspaceId, p.path);
		const workspace = getWorkspace(p.workspaceId);
		if (isChatWorkspace(workspace)) return nodes;
		const ignored = await ignoredPaths(
			workspace.worktreePath,
			nodes.map((node) => node.path),
		);
		return ignored.size === 0
			? nodes
			: nodes.map((node) => (ignored.has(node.path) ? { ...node, gitignored: true } : node));
	},
	"fs.readFile": (p) => {
		void ensureWatch(p.workspaceId);
		return readFile(
			p.workspaceId,
			p.path,
			p.maxBytes === undefined ? {} : { maxBytes: p.maxBytes },
		);
	},
	"spec.graph": (p) => {
		void ensureWatch(p.workspaceId);
		return specGraph(p.workspaceId);
	},
	"todo.list": (p) => {
		return listTodos(p);
	},
	"todo.add": async (p) => {
		const result = await addTodo(p);

		return result;
	},
	"todo.update": async (p) => {
		const result = await updateTodo(p);
		return result;
	},
	"todo.remove": (p) => removeTodo(p, () => isItemUnderActiveReview(p.sessionId, p.id)),
	"todo.review": (params) => {
		const result = approveTodoReview(params);

		return result;
	},

	"todo.generateSummary": (params) => generateTodoSummary(params),

	"git.status": (p) => {
		void ensureWatch(p.workspaceId);
		return gitStatus(p.workspaceId, p.scope);
	},

	"git.diffFile": (p) => {
		void ensureWatch(p.workspaceId);
		return gitDiffFile(p.workspaceId, p.path, p.scope);
	},
	"git.listCommits": (params) => listCommits(params.workspaceId),
	"workspace.turns": (p) => {
		getWorkspace(p.workspaceId);
		return { turns: listTurns(p.workspaceId) };
	},
	"change.revert": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await revertChange(p) }));
	},
	"change.undo": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await undoChange(p) }));
	},
	"terminal.reserve": (p) => {
		getWorkspace(p.workspaceId);
		return { tab: reserveTerminal(p.workspaceId, p.tabKey, p.title) };
	},
	"terminal.attach": (p, ctx) => {
		return attachTerminal(p.workspaceId, p.tabKey, ctx.clientKey, p);
	},
	"terminal.list": (params) => ({
		tabs: listTerminals(params.workspaceId),
	}),
	"terminal.write": (p, ctx) => {
		const workspaceId = writeTerminal(p.id, p.data, ctx.clientKey);
		if (workspaceId) recordWorkspaceActivity(workspaceId);
		return { ok: true } as const;
	},
	"terminal.resize": (p, ctx) => {
		resizeTerminal(p.id, p.cols, p.rows, ctx.clientKey);
		return { ok: true } as const;
	},
	"terminal.close": (p) => {
		return closeTerminalTab(p.workspaceId, p.tabKey, p.force ?? false);
	},

	"skill.list": (params) => {
		const { projectId } = params;
		const project = listProjects().find((candidate) => candidate.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCommands(
			project.path,
			admissionContextFor(project, {}, getConfig().otherAgentSkills),
			{ disabledExtensions: new Set(getConfig().disabledExtensions) },
		);
	},
	"skills.state": (params) => {
		const { workspaceId } = params;
		const ws = getWorkspace(workspaceId);
		const project = listProjects().find((p) => p.id === ws.projectId);
		return listSkillCatalog(
			ws.worktreePath,
			admissionContextFor(project, ws.skillOverrides ?? {}, getConfig().otherAgentSkills),
			{ disabledExtensions: new Set(getConfig().disabledExtensions) },
		);
	},
	"extension.list": () => listExtensionCatalog(new Set(getConfig().disabledExtensions)),
	"webAccess.status": () => webAccessStatus(),
	"webAccess.configure": (params) => configureWebAccess(params),

	"locales.list": () => readLocalLocales(),
	"locales.reveal": () => revealDataFolder(localesDir()),
	"themes.list": () => readUserThemes(),
	"themes.reveal": () => revealDataFolder(themesDir()),
	"fonts.list": () => readUserFonts(),
	"fonts.installed": () => listInstalledFonts(),
	"fonts.reveal": () => revealDataFolder(fontsDir()),
	"speech.install": (p) => {
		if (!isSpeechModel(p.model)) throw new Error("unknown voice model");
		installSpeech(p.model);
		return { ok: true };
	},
	"speech.cancelInstall": () => {
		cancelSpeechInstall();
		return { ok: true };
	},
	"speech.remove": async () => {
		await removeSpeech();
		return { ok: true };
	},

	"project.acknowledgeSkills": (p) => {
		const input = z.object({ id: z.string(), names: z.array(z.string()) }).parse(p);
		repositoryProject(input.id);
		return acknowledgeProjectSkills(input.id, input.names);
	},
	"project.setSkillEnabled": (p) => {
		const input = z.object({ id: z.string(), name: z.string(), enabled: z.boolean() }).parse(p);
		repositoryProject(input.id);
		return setProjectSkillEnabled(input.id, input.name, input.enabled);
	},
	"project.aliasSkills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listProjectAliasSkillNames(project.path);
	},
	"project.trustSummary": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return projectTrustSummary(project.path);
	},
	"project.setGroupEnabled": (p) => {
		const input = z.object({ id: z.string(), group: z.string(), enabled: z.boolean() }).parse(p);
		repositoryProject(input.id);
		return setProjectGroupEnabled(input.id, input.group, input.enabled);
	},
	"project.skills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCatalog(
			project.path,
			admissionContextFor(project, {}, getConfig().otherAgentSkills),
			{ disabledExtensions: new Set(getConfig().disabledExtensions) },
		);
	},
	"workspace.setSkillOverride": (p) => {
		const input = z
			.object({ id: z.string(), name: z.string(), override: z.enum(["on", "off"]).nullable() })
			.parse(p);
		return setWorkspaceSkillOverride(input.id, input.name, input.override);
	},
	"workspace.setSubagentsOverride": (p) => {
		return setWorkspaceSubagentsOverride(p.id, p.override);
	},
	"workspace.setSubagentMaxConcurrent": (p) => {
		return setWorkspaceSubagentMaxConcurrent(p.id, p.value);
	},
	"workspace.setDiffBase": (p) => {
		return setWorkspaceDiffBase(p.id, p.ref);
	},
	"workspace.watchReady": (p) => {
		return ensureWatch(p.workspaceId, { prewarm: p.prewarm === true });
	},

	"session.create": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		if (isChatWorkspace(ws)) {
			const { workspace: _workspace, ...created } = await recoverChatSession(ws.id, p);
			return created;
		}
		return startChatSession(ws, p, { pick: true });
	},
	"session.prompt": (p) => {
		const input = sessionInputSchema.parse(p);
		return sendUserMessage(() =>
			promptSession(input.sessionId, input.text, input.images, input.messageId),
		);
	},
	"session.steer": async (p) => {
		const input = sessionInputSchema.parse(p);
		await steerSession(input.sessionId, input.text, input.images, input.messageId);
		return { ok: true };
	},
	"session.followUp": async (p) => {
		const input = sessionInputSchema.parse(p);
		await followUpSession(input.sessionId, input.text, input.images, input.messageId);
		return { ok: true };
	},
	"session.clearQueue": (p) => clearSessionQueue(p.sessionId, p.requireTextOnly),
	"session.removeQueued": (p) => {
		const input = z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) }).parse(p);
		return removeQueuedMessage(input.sessionId, input.messageId);
	},
	"session.updateQueued": async (p) => {
		const input = sessionInputSchema.required({ messageId: true }).parse(p);
		await updateQueuedMessage(input.sessionId, input.messageId, input.text, input.images);
		return { ok: true };
	},
	"session.sendSteeringNow": async (p) => {
		await sendSteeringNow(p.sessionId);
		return { ok: true };
	},
	"session.compact": async (p) => {
		const input = z
			.object({
				sessionId: z.string().min(1),
				operationId: z
					.string()
					.regex(/^[A-Za-z0-9_-]{1,200}$/)
					.optional(),
				instructions: z.string().optional(),
			})
			.parse(p);
		await compactSession(input.sessionId, input);
		return { ok: true };
	},

	"session.abort": async (p) => {
		await abortSession(p.sessionId);
		return { ok: true };
	},
	"session.dispose": async (params) => {
		const { sessionId } = params;
		await removeSession(sessionId);

		return { ok: true } as const;
	},
	"session.delete": async (p) => {
		assertSessionDeletable(p.workspaceId);
		await deleteSession(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
		await removeSessionTodoWindows(p);
		return { ok: true } as const;
	},
	"session.rename": async (p) => {
		await renameSession(
			p.sessionId,
			p.workspaceId,
			getWorkspace(p.workspaceId).worktreePath,
			p.title,
		);
		return { ok: true } as const;
	},
	"session.setModel": async (p) => {
		noteRecentModel(await setSessionModel(p.sessionId, p.model));
		return { ok: true } as const;
	},
	"session.setThinkingLevel": (p) => {
		setSessionThinkingLevel(p.sessionId, p.level);
		return { ok: true } as const;
	},

	"session.getStats": (params) => getSessionStats(params.sessionId),

	"session.list": async (params, ctx) => {
		const { workspaceId } = params;
		if (!seesChats(ctx.protocolVersion) && isChatWorkspaceId(workspaceId)) {
			throw new Error(`Unknown workspace: ${workspaceId}`);
		}
		const summaries = await listSessions(workspaceId, getWorkspace(workspaceId).worktreePath);
		return summaries.map((summary) => {
			try {
				return {
					...summary,
					openTodos: countOpenTodos({ workspaceId, sessionId: summary.sessionId }),
				};
			} catch {
				return summary;
			}
		});
	},
	"session.stateList": (_params, ctx) =>
		listSessionStates(
			listAllWorkspaceRecords()
				.filter((workspace) => seesChats(ctx.protocolVersion) || !isChatWorkspace(workspace))
				.map(sessionStateWorkspace),
		),
	"session.acknowledgeCompletion": (p) => {
		return acknowledgeCompletion(p.sessionId, p.completionId);
	},

	"mcp.list": (params) => mcpList(params),
	"mcp.add": (params) => mcpAdd(params),
	"mcp.update": (params) => mcpUpdate(params),
	"mcp.remove": (params) => mcpRemove(params),
	"mcp.setProjectOverride": (params) => mcpSetProjectOverride(params),
	"mcp.revokeToolGrant": (params) => mcpRevokeToolGrant(params),
	"mcp.setSessionOverride": (params) => mcpSetSessionOverride(params),
	"mcp.approve": (params) => mcpApprove(params),
	"mcp.shareWithRepo": (params) => mcpShareWithRepo(params),
	"mcp.reconnect": (params) => mcpReconnect(params),
	"mcp.login": (params, ctx) => mcpLogin(params, ctx.clientKey),
	"mcp.logout": (params, ctx) => mcpLogout(params, ctx.clientKey),
	"mcp.readOutput": (params) => mcpReadOutput(params),
	"mcp.readLog": (params) => mcpReadLog(params),
	"mcp.testConnection": (params, ctx) => mcpTestConnection(params, ctx.clientKey),
	"session.reloadResources": async (params) => {
		const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(params);
		const record = readSessionRecord(sessionId);
		if (!record) throw new Error("Unknown session");
		const workspace = getWorkspace(record.workspaceId);
		assertChatOpen(workspace.id);
		await reloadSessionResources(sessionId, workspace.id, workspace.worktreePath);
		return { ok: true };
	},
	"session.getCommands": (params) => {
		const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(params);
		const record = readSessionRecord(sessionId);
		if (!record) throw new Error("Unknown session");
		const workspace = getWorkspace(record.workspaceId);
		assertChatOpen(workspace.id);
		if (resolve(workspace.worktreePath) !== record.cwd)
			throw new Error("Session is unavailable in its workspace");
		const config = getConfig();
		return listSkillCommands(
			record.cwd,
			admissionContextFor(
				listProjects().find((project) => project.id === workspace.projectId),
				workspace.skillOverrides ?? {},
				config.otherAgentSkills,
			),
			{ disabledExtensions: new Set(config.disabledExtensions) },
		);
	},
	"session.getMessages": (p) => {
		return getSessionMessages(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
	},

	"session.extUiReply": async (params) => {
		await attachInteractionSession(params.response.sessionId);
		await resolveExtUi(params.response);
		return { ok: true } as const;
	},
	"session.respondToTool": async (p) => {
		const input = z
			.object({
				sessionId: z.string().min(1),
				toolCallId: z.string().min(1),
				runId: z.string().min(1),
				interactionId: z.string().min(1),
				revision: z.number().int().nonnegative(),
				response: z.unknown(),
			})
			.parse(p);
		await attachInteractionSession(input.sessionId);
		await respondToTool(input.sessionId, input.toolCallId, input.response, input);
		return { ok: true } as const;
	},

	"model.list": () => listAvailableModels(),
	"model.clampThinking": async (p) => {
		return { level: await clampThinkingForModel({ provider: p.provider, id: p.id }, p.level) };
	},
	"model.refresh": () => {
		return (() => refreshAvailableModels())();
	},

	"customEndpoints.list": () => listCustomEndpoints(),
	"customEndpoints.probe": (p) => probeCustomEndpoint(p),
	"customEndpoints.save": (p) => saveCustomEndpoint(p),
	"customEndpoints.remove": (p) => removeCustomEndpoint(p.id),
	"model.default": () => (() => resolveNewChatModel({}))(),
	"provider.loginReply": (p, ctx) => {
		const input = z.object({ loginId: z.string(), value: z.string() }).parse(p);
		if (!isMcpLoginId(input.loginId)) throw new Error("Unknown MCP login");
		replyMcpProbe(input.loginId, ctx.clientKey, input.value);
		return { ok: true } as const;
	},
	"provider.loginCancel": (p, ctx) => {
		const input = z.object({ loginId: z.string() }).parse(p);
		if (!isMcpLoginId(input.loginId)) throw new Error("Unknown MCP login");
		cancelMcpProbe(input.loginId, ctx.clientKey);
		return { ok: true } as const;
	},
	"provider.status": () => getProviderStatus(),

	"host.update": (_params, ctx) => {
		if (!ctx.runHostUpdate) throw new Error("Host update is unavailable.");
		ctx.runHostUpdate();
		return { ok: true } as const;
	},
	"settings.update": (params) => {
		const config = params.config;
		return updateConfig(config);
	},
	"environment.get": () => hostEnvironmentStatus(),
	"environment.update": (params) => updateHostEnvironment(params.environment),

	"history.search": (p, ctx) => {
		const { filter, labels } = buildHistoryScope(
			p.scope,
			listProjects(),
			(projectId) => listWorkspaceRecords(projectId),
			historyHiddenCwd(ctx.protocolVersion),
		);
		return getHistoryIndex().search({
			query: p.query,
			filter,
			labels,
			limit: clampLimit(p.limit),
		});
	},

	"search.query": (p, ctx) => hostSearch().query(p, { chats: seesChats(ctx.protocolVersion) }),
	"search.text": (p, ctx) =>
		hostSearch().text(ctx.clientKey, p, (batch) => publishSearchText(ctx.clientKey, batch)),
	"search.preview": (p, ctx) => hostSearch().preview(p, { chats: seesChats(ctx.protocolVersion) }),

	"review.get": async (p) => {
		void ensureWatch(p.workspaceId);
		return markClientStale(await getReviewSnapshot(p.workspaceId), p.workspaceId);
	},
	"review.commentAdd": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const comment = await addComment(p);

			return comment;
		});
	},
	"review.commentUpdate": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const updated = await updateComment(p);

			// Resolving/dismissing the item's last open finding must clear its changes_requested verdict
			// too (no-op while findings remain), the same invariant as commentDelete.
			if (updated.origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: updated.origin.sessionId,
					id: updated.origin.todoId,
				});
			return updated;
		});
	},
	"review.commentDelete": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const origin = (await getReviewSnapshot(p.workspaceId)).comments.find(
				(c) => c.id === p.id,
			)?.origin;
			await deleteComment(p.workspaceId, p.id);
			// A changes_requested verdict must not outlive its findings: if this was the item's last open
			// finding, drop the verdict back to unreviewed.
			if (origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: origin.sessionId,
					id: origin.todoId,
				});
			return { ok: true } as const;
		});
	},
	"review.fileDone": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await markFileDone(p.workspaceId, p.path);
			return { ok: true } as const;
		});
	},
	"review.close": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await clearReview(p.workspaceId);
			return { ok: true } as const;
		});
	},
	"review.sendComment": (p) => {
		return withReviewLock(p.workspaceId, async () =>
			sendToFileChat(p.workspaceId, await sendableComments(p.workspaceId, [p.id]), p),
		);
	},
	"review.sendBatch": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const comments = await sendableComments(p.workspaceId, p.commentIds);
			const sessions: ReviewSendResult[] = [];
			for (const group of reviewSendGroups(comments, p.sessionId)) {
				sessions.push(await sendToFileChat(p.workspaceId, group, p));
			}
			if (sessions.length === 0) throw new Error("No draft comments to send.");
			return { sessions };
		});
	},
	"template.list": (params) => ({
		templates: listTemplates(resolveTemplateReadDirs(params)),
	}),
	"template.get": (p) => {
		return getTemplate(resolveTemplateReadDirs(p), p.name, p.scope);
	},
	"template.save": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		return saveTemplate(dirs, p.scope, p.name, p.content);
	},
	"template.delete": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		deleteTemplate(dirs, p.scope, p.name);
		return { ok: true } as const;
	},
};

function isWsMethod(method: string): method is WsMethodName {
	return Object.hasOwn(handlers, method);
}

function dispatch<M extends WsMethodName>(method: M, params: WsParams<M>, ctx: RequestContext) {
	const handler = handlers[method];
	if (!handler) throw new Error(`Unavailable method: ${method}`);
	return handler(params, ctx);
}

export function requestMethodDiagnostic(method: string): string {
	return isWsMethod(method) ? method : "unknown method";
}

function supportsBranchStatus(protocolVersion: number | undefined): boolean {
	return protocolVersion === undefined || protocolVersion >= BRANCH_STATUS_PROTOCOL_VERSION;
}

export function shouldRefreshOpenReview(allowCached: boolean | undefined): boolean {
	return allowCached !== true;
}

export function openReviewForClient(
	review: OpenBranchReview | null,
	protocolVersion: number | undefined,
): OpenBranchReview | null {
	if (
		!review ||
		protocolVersion === undefined ||
		protocolVersion >= WORKSPACE_SETTLE_PROTOCOL_VERSION
	)
		return review;
	return review.state === undefined || review.state === "open" ? review : null;
}

/** Git- and review-backed methods keyed by a workspace: a chat without a project is refused at the door, before any git work. */
const REPOSITORY_ONLY_METHODS: ReadonlySet<WsMethodName> = new Set<WsMethodName>([
	"git.status",
	"git.diffFile",
	"git.listCommits",
	"workspace.turns",
	"workspace.diffStats",
	"workspace.setDiffBase",
	"change.revert",
	"change.undo",
	"pr.preview",
	"pr.generate",
	"pr.ready",
	"pr.merge",
	"pr.reopen",
	"pr.open",
	"review.get",
	"review.commentAdd",
	"review.commentUpdate",
	"review.commentDelete",
	"review.fileDone",
	"review.close",
	"review.sendComment",
	"review.sendBatch",
	"todo.review",
	"todo.startReview",
	"todo.reviewAll",
	"todo.requestFix",
	"spec.graph",
]);

/** Doors that start or attach a session or a terminal: a chat being deleted, or whose deletion is pending, refuses them. */
const CHAT_RESOURCE_DOORS: ReadonlySet<WsMethodName> = new Set<WsMethodName>([
	"chat.continue",
	"session.create",
	"session.getMessages",
	"session.nudge",
	"session.resources",
	"backgroundCommand.output",
	"backgroundCommand.stop",
	"subagent.stop",
	"subagent.stopAll",
	"terminal.reserve",
	"terminal.attach",
]);

function paramWorkspaceId(params: unknown, orId: boolean): string | null {
	if (!params || typeof params !== "object") return null;
	const { workspaceId, id } = params as { workspaceId?: unknown; id?: unknown };
	if (typeof workspaceId === "string") return workspaceId;
	return orId && typeof id === "string" ? id : null;
}

function refuseRepositoryOnlyForChats(method: WsMethodName, params: unknown): void {
	if (!REPOSITORY_ONLY_METHODS.has(method)) return;
	const candidate = paramWorkspaceId(params, true);
	if (candidate === null) return;
	let workspace: Workspace;
	try {
		workspace = getWorkspace(candidate);
	} catch {
		return;
	}
	assertNotChatWorkspace(workspace, "asked about git, changes, reviews or pull requests");
}

export async function handleRequest(
	method: string,
	params: unknown,
	ctx: RequestContext,
): Promise<unknown> {
	if (!isWsMethod(method)) throw new Error(`Unknown method: ${method}`);
	refuseRepositoryOnlyForChats(method, params);
	if (CHAT_RESOURCE_DOORS.has(method)) {
		const workspaceId = paramWorkspaceId(params, false);
		if (workspaceId !== null) assertChatOpen(workspaceId);
	}
	return dispatch(method, params as WsParams<typeof method>, ctx);
}

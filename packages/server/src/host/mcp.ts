import type {
	LoginFrame,
	McpExposure,
	McpListResult,
	McpReadOutputResult,
	McpRenderedTarget,
	McpServerEntryInput,
	McpServerLog,
	McpServerScope,
	Project,
	Workspace,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	cancelMcpProbesForWorkspace,
	closeWorkspaceMcpConnections,
	effectiveMcpServerConfig,
	getSessionWorkspaceId,
	listMcpServers,
	liveSessionIdsOf,
	type McpProbeAction,
	mcpEntryFingerprint,
	mcpPolicyOf,
	readMcpServerLog,
	readMcpToolOutput,
	reconcileMcpSessions,
	reconnectMcpServer,
	refreshMcpStatus,
	removeMcpServerEntry,
	setSessionMcpServerEnabled,
	shareMcpOverrideWithRepo,
	startMcpProbe,
	writeMcpServerEntry,
} from "../agent";
import { logger } from "../log";
import {
	approveProjectMcpServer,
	getProjects,
	revokeProjectMcpTool,
	setProjectMcpOverride,
} from "../projects";
import { ensureWatch } from "../watch";
import { getWorkspace, listAllWorkspaceRecords, listWorkspaceRecords } from "../workspaces";

const LIST_WAIT_MS = 1500;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const log = logger("mcp");

function target(workspaceId: string): { workspace: Workspace; project: Project } {
	const workspace = getWorkspace(workspaceId);
	const project = getProjects().find((candidate) => candidate.id === workspace.projectId);
	if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
	void ensureWatch(workspaceId);
	return { workspace, project };
}

function assertRenderedEntry(
	name: string,
	onDisk: string | undefined,
	expectedFingerprint: string,
): void {
	if (expectedFingerprint !== onDisk) {
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			`The entry for "${name}" changed since it was opened — review it again.`,
		);
	}
}

function assertRepositoryWritable(project: Project): void {
	if (project.resourceTrust !== "granted") {
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			"This project isn't trusted — trust it before changing the MCP servers its repository defines.",
		);
	}
}

async function mutateManaged(
	workspaceId: string,
	mutation: (found: { workspace: Workspace; project: Project }) => readonly string[],
): Promise<McpListResult> {
	// Resolve and validate synchronously with the write; asynchronous transport work follows it.
	await reloadLiveSessions(mutation(target(workspaceId)));
	return mcpList({ workspaceId });
}

function serverName(name: unknown): string {
	if (typeof name !== "string" || !SERVER_NAME.test(name)) {
		throw new CodedError("MCP_CONFIG_INVALID", "MCP server names use letters, digits, - and _");
	}
	return name;
}

function serverEnabled(enabled: unknown): boolean {
	if (typeof enabled !== "boolean") {
		throw new CodedError("MCP_CONFIG_INVALID", "MCP server enabled must be a boolean");
	}
	return enabled;
}

function serverScope(scope: unknown): McpServerScope {
	if (scope !== "user" && scope !== "project") throw new Error("Invalid MCP server scope");
	return scope;
}

function renderedTarget(params: unknown): McpRenderedTarget {
	const scope = serverScope(isRecord(params) ? params.scope : undefined);
	const expectedFingerprint = isRecord(params) ? params.expectedFingerprint : undefined;
	if (typeof expectedFingerprint !== "string") {
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			"An entry is rewritten or removed only with the fingerprint it was rendered with.",
		);
	}
	return { scope, expectedFingerprint };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function ownedSession(workspaceId: string, sessionId: string): void {
	if (getSessionWorkspaceId(sessionId) !== workspaceId) {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	}
}

export async function reloadLiveSessions(workspaceIds: readonly string[]): Promise<void> {
	const ids = [...new Set(workspaceIds)];
	await Promise.all(
		ids.map(async (workspaceId) => {
			await cancelMcpProbesForWorkspace(workspaceId);
			await closeWorkspaceMcpConnections(workspaceId);
		}),
	);
	const sessionIds = ids.flatMap((workspaceId) => liveSessionIdsOf(workspaceId));
	await reconcileMcpSessions(sessionIds);
}

const projectWorkspaces = (project: Project): string[] =>
	listWorkspaceRecords(project.id).map((workspace) => workspace.id);
const allWorkspaces = (): string[] => listAllWorkspaceRecords().map((workspace) => workspace.id);

export function mcpList(params: { workspaceId: string }): Promise<McpListResult> {
	const { workspace, project } = target(params.workspaceId);
	return listMcpServers({
		workspaceId: workspace.id,
		cwd: workspace.worktreePath,
		project,
		waitMs: LIST_WAIT_MS,
	});
}

export function mcpAdd(params: {
	workspaceId: string;
	scope: McpServerScope;
	name: string;
	entry: McpServerEntryInput;
}): Promise<McpListResult> {
	const scope = serverScope(params.scope);
	const name = serverName(params.name);
	return mutateManaged(params.workspaceId, ({ workspace, project }) => {
		if (scope === "project") assertRepositoryWritable(project);
		const fingerprint = writeMcpServerEntry({
			scope,
			worktree: workspace.worktreePath,
			name,
			entry: params.entry,
			mode: "add",
		});
		if (fingerprint) approveProjectMcpServer(project.id, name, fingerprint);
		return scope === "user" ? allWorkspaces() : projectWorkspaces(project);
	});
}

/** A rewrite or removal runs only against the entry the client rendered, at either scope. */
function renderedEntry(
	params: { workspaceId: string; name: string } & McpRenderedTarget,
	write: (
		options: { scope: McpServerScope; worktree: string; name: string },
		onDisk: string | undefined,
		project: Project,
	) => void,
): Promise<McpListResult> {
	const target = renderedTarget(params);
	const name = serverName(params.name);
	return mutateManaged(params.workspaceId, ({ workspace, project }) => {
		if (target.scope === "project") assertRepositoryWritable(project);
		const onDisk = mcpEntryFingerprint(target.scope, workspace.worktreePath, name);
		assertRenderedEntry(name, onDisk, target.expectedFingerprint);
		write({ scope: target.scope, worktree: workspace.worktreePath, name }, onDisk, project);
		return target.scope === "user" ? allWorkspaces() : projectWorkspaces(project);
	});
}

export function mcpUpdate(
	params: {
		workspaceId: string;
		name: string;
		entry: McpServerEntryInput;
	} & McpRenderedTarget,
): Promise<McpListResult> {
	return renderedEntry(params, (options, onDisk, project) => {
		const fingerprint = writeMcpServerEntry({ ...options, entry: params.entry, mode: "update" });
		if (
			fingerprint &&
			onDisk !== undefined &&
			mcpPolicyOf(project).approvals[options.name] === onDisk
		)
			approveProjectMcpServer(project.id, options.name, fingerprint);
	});
}

export function mcpRemove(
	params: { workspaceId: string; name: string } & McpRenderedTarget,
): Promise<McpListResult> {
	return renderedEntry(params, (options) => removeMcpServerEntry(options));
}

export function mcpSetProjectOverride(params: {
	workspaceId: string;
	name: string;
	enabled?: boolean;
	exposure?: Exclude<McpExposure, "codemode">;
}): Promise<McpListResult> {
	const name = serverName(params.name);
	return mutateManaged(params.workspaceId, ({ project }) => {
		setProjectMcpOverride(project.id, name, {
			...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			...(params.exposure !== undefined ? { exposure: params.exposure } : {}),
		});
		return projectWorkspaces(project);
	});
}

export function mcpRevokeToolGrant(params: {
	workspaceId: string;
	name: string;
	tool: string;
}): Promise<McpListResult> {
	const name = serverName(params.name);
	if (typeof params.tool !== "string" || params.tool.length === 0) {
		throw new CodedError("MCP_CONFIG_INVALID", "Name the MCP tool to stop always allowing.");
	}
	const { tool } = params;
	return mutateManaged(params.workspaceId, ({ project }) => {
		revokeProjectMcpTool(project.id, name, tool);
		return [];
	});
}

export function mcpApprove(params: {
	workspaceId: string;
	name: string;
	fingerprint: string;
}): Promise<McpListResult> {
	const name = serverName(params.name);
	return mutateManaged(params.workspaceId, ({ workspace, project }) => {
		assertRepositoryWritable(project);
		if (
			typeof params.fingerprint !== "string" ||
			!params.fingerprint ||
			mcpEntryFingerprint("project", workspace.worktreePath, name) !== params.fingerprint
		) {
			throw new CodedError(
				"MCP_CONFIG_INVALID",
				`The entry for "${name}" changed since it was reviewed — review it again.`,
			);
		}
		approveProjectMcpServer(project.id, name, params.fingerprint);
		return projectWorkspaces(project);
	});
}

export function mcpShareWithRepo(params: {
	workspaceId: string;
	name: string;
}): Promise<McpListResult> {
	const name = serverName(params.name);
	return mutateManaged(params.workspaceId, ({ workspace, project }) => {
		assertRepositoryWritable(project);
		const { approvals, overrides } = mcpPolicyOf(project);
		const override = overrides[name];
		if (!override) {
			throw new CodedError("MCP_CONFIG_INVALID", `"${name}" has no project setting to share.`);
		}
		const fingerprint = shareMcpOverrideWithRepo({
			worktree: workspace.worktreePath,
			name,
			override,
			approvedFingerprint: approvals[name],
		});
		approveProjectMcpServer(project.id, name, fingerprint);
		setProjectMcpOverride(project.id, name, null);
		return projectWorkspaces(project);
	});
}

export async function mcpSetSessionOverride(params: {
	workspaceId: string;
	sessionId: string;
	name: string;
	enabled: boolean;
}): Promise<{ ok: true }> {
	const enabled = serverEnabled(params.enabled);
	ownedSession(params.workspaceId, params.sessionId);
	await setSessionMcpServerEnabled(params.sessionId, serverName(params.name), enabled);
	return { ok: true };
}

export async function mcpReconnect(params: {
	workspaceId: string;
	sessionId: string;
	name: string;
}): Promise<{ ok: true }> {
	ownedSession(params.workspaceId, params.sessionId);
	const name = serverName(params.name);
	try {
		await reconnectMcpServer(params.sessionId, name);
	} finally {
		await refreshMcpStatus(params.sessionId, LIST_WAIT_MS);
	}
	return { ok: true };
}

async function probe(
	action: McpProbeAction,
	params: { workspaceId: string; name: string },
	clientKey: string,
): Promise<{ loginId: string; done: Promise<LoginFrame> }> {
	const name = serverName(params.name);
	const { workspace, project } = target(params.workspaceId);
	const projectTrusted = project.resourceTrust === "granted";
	const policy = mcpPolicyOf(project);
	const effective = effectiveMcpServerConfig({
		cwd: workspace.worktreePath,
		projectTrusted,
		policy,
		name,
	});
	if (!effective) {
		throw new CodedError("MCP_CONFIG_INVALID", `No admitted MCP server named "${name}".`);
	}
	if (action === "test" && !("url" in effective)) {
		throw new CodedError(
			"MCP_CONFIG_INVALID",
			"Test connection applies to HTTP servers; a stdio server is verified when a chat starts it.",
		);
	}
	return startMcpProbe({
		action,
		workspaceId: workspace.id,
		cwd: workspace.worktreePath,
		projectTrusted,
		policy,
		serverName: name,
		ownerClientKey: clientKey,
	});
}

export async function mcpLogin(
	params: { workspaceId: string; name: string },
	clientKey: string,
): Promise<{ loginId: string }> {
	const { loginId, done } = await probe("login", params, clientKey);
	void done
		.then(async (result) => {
			if (result.kind === "success")
				await reconcileMcpSessions(liveSessionIdsOf(params.workspaceId));
		})
		.catch(() => log.warn("MCP connections could not refresh after sign-in."));
	return { loginId };
}

export async function mcpTestConnection(
	params: { workspaceId: string; name: string },
	clientKey: string,
): Promise<{ loginId: string }> {
	const { loginId } = await probe("test", params, clientKey);
	return { loginId };
}

export async function mcpLogout(
	params: { workspaceId: string; name: string },
	clientKey: string,
): Promise<{ ok: true }> {
	const last = await (await probe("logout", params, clientKey)).done;
	if (last.kind === "error") throw new Error(last.message);
	await reconcileMcpSessions(liveSessionIdsOf(params.workspaceId));
	return { ok: true };
}

export function mcpReadLog(params: { workspaceId: string; name: string }): Promise<McpServerLog> {
	target(params.workspaceId);
	return readMcpServerLog(serverName(params.name));
}

export function mcpReadOutput(params: {
	workspaceId: string;
	sessionId: string;
	toolCallId: string;
}): Promise<McpReadOutputResult> {
	ownedSession(params.workspaceId, params.sessionId);
	return readMcpToolOutput(
		params.workspaceId,
		params.sessionId,
		params.toolCallId,
		getWorkspace(params.workspaceId).worktreePath,
	);
}

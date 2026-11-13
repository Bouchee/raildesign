import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import type {
	HostPlatform,
	HostUpdateNotice,
	ServerWelcome,
	SessionCreatedPayload,
	SessionDeletedPayload,
	SessionStateRecord,
	TerminalTabsPush,
	WorkspaceFsChangedPayload,
	WsChannel,
} from "@thinkrail/contracts";
import {
	CONTINUATION_PROTOCOL_VERSION,
	FONTS_PROTOCOL_VERSION,
	LOCALES_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	SPEECH_PROTOCOL_VERSION,
	SPEECH_SOCKET_ROUTE,
	TEXT_SEARCH_PROTOCOL_VERSION,
	USER_FONTS_ROUTE,
	USER_THEMES_PROTOCOL_VERSION,
	WORKSPACE_CREATION_PROTOCOL_VERSION,
	WS_CHANNELS,
	WS_MAX_FRAME_BYTES,
} from "@thinkrail/contracts";
import { errorCodeOf } from "@thinkrail/shared/codedError";
import { WORKSPACE_CONTEXT_DIR } from "@thinkrail/shared/paths";
import { lockSync } from "proper-lockfile";
import {
	cancelAllMcpProbes,
	cancelMcpProbesOwnedBy,
	closeAllMcpConnections,
	closeSessionMcpConnections,
	disposeAllSessions,
	getSessionWorkspaceId,
	initializeSessionStates,
	isProjectSkillPath,
	mayHoldProjectSkills,
	resolveProviderAuthorization,
	setAgentTitleHost,
	setContinueToolHost,
	setExtUiPublisher,
	setMcpAuthorizationResolver,
	setMcpLoginPublisher,
	setMcpProjectResolver,
	setMcpStatusPublisher,
	setMcpToolGrantWriter,
	setRequestReviewHandler,
	setResolveCommentHandler,
	setSessionCreatedPublisher,
	setSessionDeletedPublisher,
	setSessionProjectResolver,
	setSessionPublisher,
	setSessionResourceCleanup,
	setSessionResourcesPublisher,
	setSessionStatePublisher,
	settleSessionsForShutdown,
	setWorkspaceToolsHost,
	watchUserMcpConfig,
} from "../agent";
import { forgetOpenBranchReview } from "../branch-review";
import { watchUserFonts } from "../fonts";
import { ignoredPaths } from "../git";
import { watchLocalLocales } from "../locales";
import { logger } from "../log";
import { dataDir, loadWorkspaces } from "../persistence";
import {
	grantProjectMcpTool,
	listProjects,
	listRecentProjects,
	openProject,
	refreshRecentProjectFolders,
	setProjectPathGuard,
	setProjectPublisher,
} from "../projects";
import { reanchorWorkspace, setReviewPublisher } from "../reviews";
import { getConfig, setSettingsPublisher } from "../settings";
import {
	createSpeechRelay,
	initSpeech,
	type SpeechRelay,
	setSpeechPublisher,
	speechStatus,
	stopEngine,
	stopSpeechInstall,
} from "../speech";
import {
	clearTerminalClient,
	closeAllTerminals,
	persistTerminalSessions,
	resumeClientTerminals,
	reviveTerminalSessions,
	setTerminalPublisher,
	setTerminalTabsPublisher,
} from "../terminal";
import { watchUserThemes } from "../themes";
import { isTodoToolEnd, maybeAttachChangeArtifacts } from "../todos";
import { setTurnPublisher, TurnTracker } from "../turns";
import {
	setIgnoredPathsResolver,
	setRepoMetaPublisher,
	setSkillPathClassifier,
	setWatchPublisher,
	setWatchStartedPublisher,
	stopAllWatches,
} from "../watch";
import {
	creationOwnsPath,
	ensureChatsContainer,
	getWorkspace,
	interruptWorkspaceCreations,
	isChatsContainer,
	isChatsContainerId,
	isChatWorkspaceId,
	recordWorkspaceHead,
	replayPendingHandoffs,
	seedWorkspaceHead,
	setChatPublishers,
	setWorkspaceCreationHandoff,
	setWorkspaceCreationPublisher,
	setWorkspacePublisher,
	stopWorkspaceCreations,
	syncWorkspaceBranch,
	type WorkspaceLifecycleEvent,
} from "../workspaces";
import { seesChats } from "./chats";
import {
	clearContinuations,
	continueToolHost,
	observeContinuation,
	setContinuationPublisher,
} from "./continuations";
import { BLOB_PREFIX, FILES_PREFIX, serveBlob, serveWorktreeFile } from "./fileRoutes";
import { serveUserFonts } from "./fontRoutes";
import { setFsNudgePublisher } from "./fsNudge";
import { applyGitCeiling } from "./gitCeiling";
import { handleRequest, requestMethodDiagnostic, workspaceCreationHandoff } from "./handlers";
import { provisionInitialTerminal } from "./initialTerminal";
import { reloadLiveSessions } from "./mcp";
import {
	type ReplayLoad,
	RequestReplayCache,
	RequestReplayOverflowError,
} from "./requestReplayCache";
import {
	installRequestReviewSeam,
	maybeAutoReReview,
	setReviewFailedPublisher,
} from "./requestReview";
import { hostSearch, setSearchTextPublisher } from "./search";
import {
	REVIEW_REFRESH_INTERVAL_MS,
	refreshOpenProjectReviews,
	stampSessionActivity,
} from "./settledLifecycle";
import {
	BACKPRESSURE_RECONCILE_MS,
	drainedClientKeys,
	terminalDeliveryForSendStatus,
} from "./terminalSend";
import { titleToolHost } from "./titleTool";
import { workspaceToolsHost } from "./workspaceTools";

export interface CreateServerOptions {
	port?: number;
	host?: string;
	staticDir?: string;
	projectPath?: string;
	appVersion?: string;
	hostUpdate?: {
		intervalMs: number;
		check(): Promise<HostUpdateNotice | null>;
		run(): Promise<void>;
	};
}

export interface RunningServer {
	readonly port: number;
	stop: () => void;
	shutdown: () => Promise<void>;
}

interface SocketData {
	clientKey: string;
	protocolVersion: number;
	/** Present only on a `/speech` socket, which bypasses the JSON request wire entirely. */
	speech?: SpeechRelay;
	speechSocket?: true;
}

const CLIENT_REPLAY_RETENTION_MS = 60_000;
const RECENT_FOLDER_CHECK_BUDGET_MS = 250;

const log = logger("host");

const isRequestId = (id: unknown): id is string => typeof id === "string";

const onScratchDirPath = (path: string) =>
	path === WORKSPACE_CONTEXT_DIR ||
	WORKSPACE_CONTEXT_DIR.startsWith(`${path}/`) ||
	path.startsWith(`${WORKSPACE_CONTEXT_DIR}/`);

function formatReplayLoad(load: ReplayLoad): string {
	const occupancy = ({ pending, settled, abandoned }: ReplayLoad[string]) =>
		pending + settled + abandoned;
	return Object.entries(load)
		.sort(([, a], [, b]) => occupancy(b) - occupancy(a))
		.map(
			([method, { pending, settled, abandoned }]) =>
				`${method} ${pending} pending/${settled} settled/${abandoned} abandoned`,
		)
		.join(", ");
}

function countMethods(methods: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const method of methods) counts.set(method, (counts.get(method) ?? 0) + 1);
	return [...counts].map(([method, count]) => `${method} ×${count}`).join(", ");
}

function clientProtocolVersion(value: string | null): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sameHostUpdateRelease(
	current: HostUpdateNotice | undefined,
	next: HostUpdateNotice,
): boolean {
	return (
		current !== undefined &&
		current.currentVersion === next.currentVersion &&
		current.availableVersion === next.availableVersion &&
		current.channel === next.channel
	);
}

export async function createServer(options: CreateServerOptions = {}): Promise<RunningServer> {
	const directory = dataDir();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const release = lockSync(directory, { lockfilePath: join(directory, "host.lock") });
	try {
		const host = await createOwnedServer(options);
		let closing: Promise<void> | undefined;
		const shutdown = (): Promise<void> => {
			closing ??= host.shutdown().then(() => release());
			return closing;
		};
		return {
			port: host.port,
			shutdown,
			stop: () => {
				void shutdown().catch((error) => log.warn("host shutdown failed", error));
				host.stop();
			},
		};
	} catch (error) {
		restoreSeamDefaults();
		release();
		throw error;
	}
}

async function createOwnedServer(options: CreateServerOptions): Promise<RunningServer> {
	applyGitCeiling();
	try {
		ensureChatsContainer();
	} catch (error) {
		log.warn(`chats without a project are unavailable: ${String(error)}`);
	}

	getConfig();

	const {
		port = 24242,
		host = "localhost",
		staticDir,
		projectPath,
		appVersion,
		hostUpdate,
	} = options;

	setSessionProjectResolver((workspaceId) => {
		try {
			return getWorkspace(workspaceId).projectId;
		} catch {
			return null;
		}
	});
	setSessionResourceCleanup(closeSessionMcpConnections);
	setAgentTitleHost(titleToolHost);
	setWorkspaceToolsHost(workspaceToolsHost);
	setContinueToolHost(continueToolHost);
	installRequestReviewSeam();
	setMcpProjectResolver((workspaceId) => {
		try {
			const workspace = getWorkspace(workspaceId);
			return listProjects().find((project) => project.id === workspace.projectId);
		} catch {
			return undefined;
		}
	});
	setMcpToolGrantWriter((workspaceId, server, target, tool) => {
		const workspace = getWorkspace(workspaceId);
		grantProjectMcpTool(workspace.projectId, server, target, tool);
	});
	setMcpAuthorizationResolver(async (provider) => resolveProviderAuthorization(provider));
	setSkillPathClassifier(isProjectSkillPath);
	await initializeSessionStates(
		loadWorkspaces().map((workspace) => ({
			id: workspace.id,
			projectId: workspace.projectId,
			cwd: workspace.worktreePath,
		})),
	);

	const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const requestReplays = new RequestReplayCache<string>();
	const reportAbandoned = (methods: readonly string[]): void => {
		if (methods.length === 0) return;
		log.warn(`requests abandoned before their handlers settled: ${countMethods(methods)}`);
	};
	const terminalBackpressured = new Set<string>();
	let hostUpdateNotice: HostUpdateNotice | undefined;
	let hostUpdateTimer: ReturnType<typeof setInterval> | undefined;
	const reviewRefreshTimer = setInterval(
		() =>
			void refreshOpenProjectReviews().catch(() =>
				log.warn("periodic settled lifecycle refresh failed"),
			),
		REVIEW_REFRESH_INTERVAL_MS,
	);
	reviewRefreshTimer.unref?.();
	let hostUpdateActive = hostUpdate !== undefined;
	let hostUpdateChecking = false;
	let requestHostUpdate = (): void => {
		throw new Error("Host update is unavailable.");
	};
	let stopping = false;
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;

	const armClientReap = (clientKey: string): void => {
		reapTimers.set(
			clientKey,
			setTimeout(() => {
				reapTimers.delete(clientKey);
				if (sockets.has(clientKey)) return;
				if (!requestReplays.clearClient(clientKey)) {
					armClientReap(clientKey);
					return;
				}
				clearTerminalClient(clientKey);
				cancelMcpProbesOwnedBy(clientKey);

				hostSearch().forgetClient(clientKey);
			}, CLIENT_REPLAY_RETENTION_MS),
		);
	};

	let server: Bun.Server<SocketData>;
	try {
		server = Bun.serve<SocketData, never>({
			port,
			hostname: host,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (shuttingDown) return new Response("Host is shutting down.", { status: 503 });
				if (url.pathname === "/ws") {
					const clientKey = url.searchParams.get("client") ?? `anon-${randomUUID()}`;
					const protocolVersion = clientProtocolVersion(url.searchParams.get("protocol"));
					await refreshRecentProjectFolders(RECENT_FOLDER_CHECK_BUDGET_MS);
					return srv.upgrade(req, { data: { clientKey, protocolVersion } })
						? undefined
						: new Response("ws upgrade failed", { status: 400 });
				}
				if (url.pathname === SPEECH_SOCKET_ROUTE) {
					const protocolVersion = clientProtocolVersion(url.searchParams.get("protocol"));
					if (protocolVersion < SPEECH_PROTOCOL_VERSION) {
						return new Response("speech needs a newer client", { status: 400 });
					}
					const clientKey = url.searchParams.get("client") ?? `anon-${randomUUID()}`;
					return srv.upgrade(req, { data: { clientKey, protocolVersion, speechSocket: true } })
						? undefined
						: new Response("ws upgrade failed", { status: 400 });
				}
				if (url.pathname === "/health") {
					return new Response("ok");
				}
				if (url.pathname.startsWith(FILES_PREFIX)) {
					return serveWorktreeFile(url.pathname, url.searchParams.get("maxBytes"));
				}
				if (url.pathname.startsWith(BLOB_PREFIX)) {
					return serveBlob(url.pathname, req.signal);
				}
				if (url.pathname.startsWith(USER_FONTS_ROUTE)) {
					return serveUserFonts(req, url.pathname);
				}
				if (staticDir) {
					return serveStatic(url.pathname, staticDir);
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				maxPayloadLength: WS_MAX_FRAME_BYTES,
				open(ws) {
					if (shuttingDown) {
						ws.close();
						return;
					}
					if (ws.data.speechSocket) {
						ws.data.speech = createSpeechRelay(ws);
						return;
					}
					const replaced = sockets.get(ws.data.clientKey);
					sockets.set(ws.data.clientKey, ws);
					if (replaced && replaced !== ws) replaced.close();
					terminalBackpressured.delete(ws.data.clientKey);
					const pendingReap = reapTimers.get(ws.data.clientKey);
					if (pendingReap !== undefined) {
						clearTimeout(pendingReap);
						reapTimers.delete(ws.data.clientKey);
					}
					ws.subscribe(WS_CHANNELS.sessionEvent);
					ws.subscribe(WS_CHANNELS.sessionExtensionUi);
					ws.subscribe(WS_CHANNELS.sessionCreated);
					ws.subscribe(WS_CHANNELS.sessionDeleted);
					ws.subscribe(WS_CHANNELS.sessionResourcesChanged);
					ws.subscribe(WS_CHANNELS.sessionState);
					ws.subscribe(WS_CHANNELS.providerLogin);
					ws.subscribe(WS_CHANNELS.providerChanged);
					ws.subscribe(WS_CHANNELS.projectUpdated);
					ws.subscribe(WS_CHANNELS.terminalTabs);
					ws.subscribe(WS_CHANNELS.workspaceCreated);
					ws.subscribe(WS_CHANNELS.workspaceUpdated);
					ws.subscribe(WS_CHANNELS.workspaceRemoved);
					ws.subscribe(WS_CHANNELS.workspaceFsChanged);
					if (ws.data.protocolVersion >= WORKSPACE_CREATION_PROTOCOL_VERSION) {
						ws.subscribe(WS_CHANNELS.workspaceCreationChanged);
						ws.subscribe(WS_CHANNELS.workspaceCreationRemoved);
					}
					if (ws.data.protocolVersion >= CONTINUATION_PROTOCOL_VERSION)
						ws.subscribe(WS_CHANNELS.chatContinuation);
					ws.subscribe(WS_CHANNELS.settingsChanged);
					if (hostUpdate) ws.subscribe(WS_CHANNELS.hostUpdateAvailable);
					ws.subscribe(WS_CHANNELS.reviewChanged);
					ws.subscribe(WS_CHANNELS.reviewFailed);
					ws.subscribe(WS_CHANNELS.turnChanged);
					if (ws.data.protocolVersion >= MCP_PROTOCOL_VERSION) ws.subscribe(WS_CHANNELS.mcpStatus);
					if (ws.data.protocolVersion >= LOCALES_PROTOCOL_VERSION)
						ws.subscribe(WS_CHANNELS.localesChanged);
					if (ws.data.protocolVersion >= USER_THEMES_PROTOCOL_VERSION)
						ws.subscribe(WS_CHANNELS.themesChanged);
					if (ws.data.protocolVersion >= FONTS_PROTOCOL_VERSION)
						ws.subscribe(WS_CHANNELS.fontsChanged);
					const speech = ws.data.protocolVersion >= SPEECH_PROTOCOL_VERSION;
					if (speech) ws.subscribe(WS_CHANNELS.speechChanged);
					const hostPlatform: HostPlatform =
						process.platform === "darwin" || process.platform === "win32"
							? process.platform
							: "linux";

					const chats = seesChats(ws.data.protocolVersion);
					const welcome: ServerWelcome = {
						protocolVersion: PROTOCOL_VERSION,
						hostPlatform,
						projects: listProjects().filter((project) => chats || !isChatsContainer(project)),
						recentProjects: listRecentProjects().filter((project) => !isChatsContainer(project)),
						config: getConfig(),
						...(speech ? { speech: speechStatus() } : {}),
						...(appVersion ? { appVersion } : {}),
						...(hostUpdateNotice ? { hostUpdate: hostUpdateNotice } : {}),
					};

					const welcomeStatus = ws.send(
						JSON.stringify({ channel: WS_CHANNELS.serverWelcome, data: welcome }),
					);
					const welcomeDelivery = terminalDeliveryForSendStatus(welcomeStatus);
					if (welcomeDelivery === "unavailable") {
						ws.close();
						return;
					}
					if (welcomeDelivery === "backpressured") {
						terminalBackpressured.add(ws.data.clientKey);
					}
					resumeClientTerminals(ws.data.clientKey);
				},
				async message(ws, message) {
					if (shuttingDown) {
						ws.close();
						return;
					}
					if (ws.data.speechSocket) {
						ws.data.speech?.message(message);
						return;
					}
					const raw = typeof message === "string" ? message : message.toString();
					let req: unknown;
					try {
						req = JSON.parse(raw);
					} catch {
						return;
					}
					if (typeof req !== "object" || req === null) return;
					if ("ack" in req && Array.isArray(req.ack)) {
						reportAbandoned(
							requestReplays.acknowledge(ws.data.clientKey, req.ack.filter(isRequestId)),
						);
						return;
					}
					if ("resume" in req && Array.isArray(req.resume)) {
						reportAbandoned(
							requestReplays.retain(ws.data.clientKey, req.resume.filter(isRequestId)),
						);
						return;
					}
					if (
						!("id" in req) ||
						typeof req.id !== "string" ||
						!("method" in req) ||
						typeof req.method !== "string"
					) {
						return;
					}
					const requestId = req.id;
					const method = req.method;
					const methodDiagnostic = requestMethodDiagnostic(method);
					const params = "params" in req ? req.params : undefined;
					const sessionId = "sessionId" in req ? req.sessionId : undefined;
					const fingerprint = createHash("sha256")
						.update(JSON.stringify([method, params, sessionId ?? null]))
						.digest("hex");
					log.debug(`ws ${methodDiagnostic}`);
					try {
						const response = await requestReplays.run(
							ws.data.clientKey,
							requestId,
							fingerprint,
							async () => {
								try {
									if (shuttingDown) throw new Error("Host is shutting down.");
									const result = await handleRequest(method, params, {
										clientKey: ws.data.clientKey,
										protocolVersion: ws.data.protocolVersion,
										...(hostUpdate ? { runHostUpdate: requestHostUpdate } : {}),
									});
									return JSON.stringify({ id: requestId, ok: true, result });
								} catch (err) {
									const error = err instanceof Error ? err.message : String(err);
									log.debug(`ws ${methodDiagnostic} failed`);

									const code = errorCodeOf(err);
									return JSON.stringify({
										id: requestId,
										ok: false,
										error,
										...(code ? { errorCode: code } : {}),
									});
								}
							},
							methodDiagnostic,
						);
						if (ws.send(response) === 0) ws.close();
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						if (err instanceof RequestReplayOverflowError && err.load) {
							log.warn(`replay namespace full; held requests: ${formatReplayLoad(err.load)}`);
						}
						const code = errorCodeOf(err);
						const reply = JSON.stringify({
							id: requestId,
							ok: false,
							error,
							...(code ? { errorCode: code } : {}),
						});
						if (ws.send(reply) === 0) ws.close();
					}
				},
				drain(ws) {
					if (ws.data.speechSocket) return;
					if (sockets.get(ws.data.clientKey) !== ws) return;
					terminalBackpressured.delete(ws.data.clientKey);
					resumeClientTerminals(ws.data.clientKey);
				},
				close(ws) {
					if (ws.data.speechSocket) {
						ws.data.speech?.close();
						return;
					}
					const { clientKey } = ws.data;
					if (stopping) return;
					if (sockets.get(clientKey) === ws) {
						sockets.delete(clientKey);
						terminalBackpressured.delete(clientKey);
						hostSearch().cancelText(clientKey);
					}
					if (sockets.has(clientKey) || reapTimers.has(clientKey)) return;
					armClientReap(clientKey);
				},
			},
		});
	} catch (error) {
		clearInterval(reviewRefreshTimer);
		throw error;
	}

	const backpressureReconciler = setInterval(() => {
		const drained = drainedClientKeys(terminalBackpressured, (clientKey) =>
			sockets.get(clientKey)?.getBufferedAmount(),
		);
		for (const clientKey of drained) {
			log.warn(
				`terminal backpressure latch lifted by reconciler, drain never arrived (${clientKey})`,
			);
			terminalBackpressured.delete(clientKey);
			resumeClientTerminals(clientKey);
		}
	}, BACKPRESSURE_RECONCILE_MS);

	const publishHostUpdate = (notice: HostUpdateNotice): void => {
		if (!hostUpdateActive) return;
		hostUpdateNotice = notice;
		server.publish(
			WS_CHANNELS.hostUpdateAvailable,
			JSON.stringify({ channel: WS_CHANNELS.hostUpdateAvailable, data: notice }),
		);
	};

	const clearHostUpdateTimer = (): void => {
		if (hostUpdateTimer !== undefined) clearInterval(hostUpdateTimer);
		hostUpdateTimer = undefined;
	};

	const hostUpdateBlocksDiscovery = (): boolean =>
		hostUpdateNotice?.status === "running" || hostUpdateNotice?.status === "succeeded";

	const checkForHostUpdate = async (): Promise<void> => {
		if (!hostUpdate || !hostUpdateActive || hostUpdateChecking || hostUpdateBlocksDiscovery()) {
			return;
		}
		hostUpdateChecking = true;
		try {
			const result = await hostUpdate.check();
			if (!hostUpdateActive || hostUpdateBlocksDiscovery()) return;
			if (result && !sameHostUpdateRelease(hostUpdateNotice, result)) {
				publishHostUpdate({
					currentVersion: result.currentVersion,
					availableVersion: result.availableVersion,
					channel: result.channel,
					status: "available",
				});
			}
		} catch {
		} finally {
			hostUpdateChecking = false;
		}
	};

	requestHostUpdate = (): void => {
		if (!hostUpdate || !hostUpdateActive || !hostUpdateNotice) {
			throw new Error("Host update is unavailable.");
		}
		if (hostUpdateNotice.status === "running" || hostUpdateNotice.status === "succeeded") {
			return;
		}
		publishHostUpdate({ ...hostUpdateNotice, status: "running" });
		void (async () => {
			try {
				await hostUpdate.run();
				if (!hostUpdateActive || hostUpdateNotice?.status !== "running") return;
				publishHostUpdate({ ...hostUpdateNotice, status: "succeeded" });
				clearHostUpdateTimer();
			} catch {
				if (!hostUpdateActive || hostUpdateNotice?.status !== "running") return;
				publishHostUpdate({ ...hostUpdateNotice, status: "failed" });
			}
		})();
	};

	const stopHostUpdateChecks = (): void => {
		hostUpdateActive = false;
		clearHostUpdateTimer();
	};

	setTerminalPublisher((clientKey, channel, data) => {
		if (terminalBackpressured.has(clientKey)) return "unavailable";
		const ws = sockets.get(clientKey);
		if (!ws) return "unavailable";
		try {
			const delivery = terminalDeliveryForSendStatus(ws.send(JSON.stringify({ channel, data })));
			if (delivery !== "delivered") terminalBackpressured.add(clientKey);
			return delivery;
		} catch {
			terminalBackpressured.add(clientKey);
			ws.close();
			return "unavailable";
		}
	});

	setSearchTextPublisher((clientKey, batch) => {
		const ws = sockets.get(clientKey);
		if (!ws || ws.data.protocolVersion < TEXT_SEARCH_PROTOCOL_VERSION) return;
		try {
			ws.send(JSON.stringify({ channel: WS_CHANNELS.searchTextResults, data: batch }));
		} catch {
			ws.close();
		}
	});

	/**
	 * A push about a chat without a project, or its container, reaches only sockets that know the
	 * kind; everything else broadcasts. One sender for every id-carrying channel.
	 */
	const publishScoped = (
		channel: string,
		data: unknown,
		scope: { workspaceId?: string; projectId?: string; belowProtocol?: number },
	) => {
		const frame = JSON.stringify({ channel, data });
		const aboutChats =
			(scope.workspaceId !== undefined && isChatWorkspaceId(scope.workspaceId)) ||
			(scope.projectId !== undefined && isChatsContainerId(scope.projectId));
		const floor = scope.belowProtocol ?? 0;
		if (floor === 0 && !aboutChats) {
			server.publish(channel, frame);
			return;
		}
		for (const socket of sockets.values()) {
			if (socket.data.protocolVersion < floor) continue;
			if (aboutChats && !seesChats(socket.data.protocolVersion)) continue;
			try {
				socket.send(frame);
			} catch {}
		}
	};

	setProjectPublisher((project) => {
		publishScoped(WS_CHANNELS.projectUpdated, project, { projectId: project.id });
	});

	setTerminalTabsPublisher((workspaceId, tabs) => {
		const data: TerminalTabsPush = { workspaceId, tabs };
		publishScoped(WS_CHANNELS.terminalTabs, data, { workspaceId });
	});

	interruptWorkspaceCreations();
	setProjectPathGuard((path) => {
		if (creationOwnsPath(path))
			throw new Error("This folder belongs to a workspace RailDesign is still creating");
	});
	setWorkspaceCreationHandoff(workspaceCreationHandoff);
	void replayPendingHandoffs().catch((err) => log.warn("replaying workspace handoffs failed", err));
	setWorkspaceCreationPublisher((event) => {
		const channel =
			event.kind === "changed"
				? WS_CHANNELS.workspaceCreationChanged
				: WS_CHANNELS.workspaceCreationRemoved;
		const data = event.kind === "changed" ? event.creation : event.removed;
		server.publish(channel, JSON.stringify({ channel, data }));
	});

	const publishWorkspaceEvent = (event: WorkspaceLifecycleEvent) => {
		const channel =
			event.kind === "created"
				? WS_CHANNELS.workspaceCreated
				: event.kind === "updated"
					? WS_CHANNELS.workspaceUpdated
					: WS_CHANNELS.workspaceRemoved;
		const data =
			event.kind === "removed" ? { projectId: event.projectId, id: event.id } : event.workspace;
		const workspaceId = event.kind === "removed" ? event.id : event.workspace.id;
		const projectId = event.kind === "removed" ? event.projectId : event.workspace.projectId;
		publishScoped(channel, data, { workspaceId, projectId });
	};
	setWorkspacePublisher(publishWorkspaceEvent);
	setChatPublishers({
		project: (project) =>
			publishScoped(WS_CHANNELS.projectUpdated, project, { projectId: project.id }),
		workspace: publishWorkspaceEvent,
		removed: (projectId, id) =>
			publishScoped(WS_CHANNELS.workspaceRemoved, { projectId, id }, { projectId }),
	});

	const publishFsChanged = (payload: WorkspaceFsChangedPayload) => {
		if (shuttingDown) return;
		if (
			payload.truncated ||
			payload.paths.some((path) => path === ".raildesign/mcp.json" || path === ".raildesign")
		) {
			void reloadLiveSessions([payload.workspaceId]).catch((error) =>
				log.warn("MCP config reload failed", error),
			);
		}
		publishScoped(WS_CHANNELS.workspaceFsChanged, payload, { workspaceId: payload.workspaceId });
		reanchorWorkspace(payload.workspaceId);
		const changedRoot = loadWorkspaces().find((w) => w.id === payload.workspaceId)?.worktreePath;
		if (changedRoot) hostSearch().invalidateRoot(changedRoot);
	};

	const nudge = (channel: WsChannel) => () =>
		server.publish(channel, JSON.stringify({ channel, data: {} }));
	const stopLocalesWatch = watchLocalLocales({ onChange: nudge(WS_CHANNELS.localesChanged) });
	const stopThemesWatch = watchUserThemes({ onChange: nudge(WS_CHANNELS.themesChanged) });
	const stopFontsWatch = watchUserFonts({ onChange: nudge(WS_CHANNELS.fontsChanged) });
	const stopMcpWatch = watchUserMcpConfig();
	setSpeechPublisher((status) =>
		server.publish(
			WS_CHANNELS.speechChanged,
			JSON.stringify({ channel: WS_CHANNELS.speechChanged, data: status }),
		),
	);
	void initSpeech().catch((err) => log.warn("voice input state could not be read", err));
	setWatchPublisher(publishFsChanged);
	setIgnoredPathsResolver((worktreePath, paths) =>
		ignoredPaths(
			worktreePath,
			paths.filter((path) => !mayHoldProjectSkills(path) && !onScratchDirPath(path)),
		),
	);
	setFsNudgePublisher(publishFsChanged);

	setWatchStartedPublisher(seedWorkspaceHead);
	setRepoMetaPublisher((workspaceId) => {
		recordWorkspaceHead(workspaceId);
		syncWorkspaceBranch(workspaceId);
		const workspace = loadWorkspaces().find((w) => w.id === workspaceId);
		if (workspace) forgetOpenBranchReview(workspace.worktreePath);
		publishFsChanged({ workspaceId, paths: [], truncated: false, skillChange: "none" });
	});

	setReviewPublisher((payload) => {
		server.publish(
			WS_CHANNELS.reviewChanged,
			JSON.stringify({
				channel: WS_CHANNELS.reviewChanged,
				data: payload,
			}),
		);
	});

	setSettingsPublisher((config) => {
		server.publish(
			WS_CHANNELS.settingsChanged,
			JSON.stringify({ channel: WS_CHANNELS.settingsChanged, data: config }),
		);
	});

	setSessionCreatedPublisher((payload: SessionCreatedPayload) => {
		publishScoped(WS_CHANNELS.sessionCreated, payload, { workspaceId: payload.workspaceId });
	});

	setSessionStatePublisher((record: SessionStateRecord) => {
		stampSessionActivity(record);
		publishScoped(WS_CHANNELS.sessionState, record, { workspaceId: record.workspaceId });
	});

	setSessionDeletedPublisher((payload: SessionDeletedPayload) => {
		publishScoped(WS_CHANNELS.sessionDeleted, payload, { workspaceId: payload.workspaceId });
	});

	const turnTracker = new TurnTracker((sessionId) => {
		const workspaceId = getSessionWorkspaceId(sessionId);
		if (!workspaceId || isChatWorkspaceId(workspaceId)) return null;
		try {
			return { workspaceId, worktreePath: getWorkspace(workspaceId).worktreePath };
		} catch {
			return null;
		}
	});
	setTurnPublisher((turn) => {
		publishScoped(WS_CHANNELS.turnChanged, turn, { workspaceId: turn.workspaceId });
	});
	setSessionResourcesPublisher((resources) =>
		publishScoped(WS_CHANNELS.sessionResourcesChanged, resources, {
			workspaceId: resources.workspaceId,
		}),
	);
	setSessionPublisher((payload, workspaceId) => {
		observeContinuation(payload.sessionId, payload.event);
		if (isTodoToolEnd(payload.event))
			void maybeAttachChangeArtifacts(workspaceId, payload.sessionId)
				.then(() => maybeAutoReReview(workspaceId, payload.sessionId))
				.catch((error) => log.warn("Plan artifact update failed", error));
		void turnTracker
			.observe(payload.sessionId, payload.event)
			.catch((error) => log.warn("turn snapshot failed", error));
		publishScoped(WS_CHANNELS.sessionEvent, payload, { workspaceId });
	});
	setContinuationPublisher((continuation) => {
		server.publish(
			WS_CHANNELS.chatContinuation,
			JSON.stringify({ channel: WS_CHANNELS.chatContinuation, data: continuation }),
		);
	});
	setReviewFailedPublisher((failure) =>
		publishScoped(WS_CHANNELS.reviewFailed, failure, { workspaceId: failure.workspaceId }),
	);

	setExtUiPublisher((request) => {
		const workspaceId = getSessionWorkspaceId(request.sessionId);
		if (workspaceId) publishScoped(WS_CHANNELS.sessionExtensionUi, request, { workspaceId });
	});
	setMcpLoginPublisher((push, ownerClientKey) => {
		sockets
			.get(ownerClientKey)
			?.send(JSON.stringify({ channel: WS_CHANNELS.providerLogin, data: push }));
	});
	setMcpStatusPublisher((snapshot) => {
		publishScoped(WS_CHANNELS.mcpStatus, snapshot, { workspaceId: snapshot.workspaceId });
	});

	reviveTerminalSessions();
	for (const workspace of loadWorkspaces()) provisionInitialTerminal(workspace);

	if (projectPath) {
		try {
			openProject(projectPath);
		} catch {
			log.warn("could not open requested project");
		}
	}

	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		clearInterval(reviewRefreshTimer);

		stopHostUpdateChecks();

		stopAllWatches();

		stopLocalesWatch();
		stopThemesWatch();
		stopFontsWatch();
		void stopMcpWatch().catch((error) => log.warn("MCP watcher cleanup failed", error));
		stopSpeechInstall();
		void stopEngine();
		disposeAllSessions();
		for (const timer of reapTimers.values()) clearTimeout(timer);
		reapTimers.clear();
		sockets.clear();
		clearInterval(backpressureReconciler);
		terminalBackpressured.clear();
		requestReplays.clear();
		persistTerminalSessions();
		closeAllTerminals();
		restoreSeamDefaults();
		server.stop(true);
	};
	const shutdown = (): Promise<void> => {
		shutdownPromise ??= (async () => {
			shuttingDown = true;
			stopHostUpdateChecks();
			stopAllWatches();
			const watcher = await Promise.allSettled([stopMcpWatch()]);
			const cleanup = () =>
				Promise.allSettled([
					settleSessionsForShutdown(),
					stopWorkspaceCreations(),
					cancelAllMcpProbes(),
					closeAllMcpConnections(),
				]);
			const [results] = await Promise.all([cleanup(), requestReplays.drain()]);
			results.push(...watcher);
			// Accepted handlers can finish creating resources while their first cancellation settles.
			results.push(...(await cleanup()));
			try {
				await turnTracker.drain();
			} finally {
				stop();
			}
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failures.length > 0) throw new AggregateError(failures, "Host resource cleanup failed");
		})();
		return shutdownPromise;
	};

	if (hostUpdate) {
		void checkForHostUpdate();
		hostUpdateTimer = setInterval(() => void checkForHostUpdate(), hostUpdate.intervalMs);
	}

	return {
		get port() {
			return server.port ?? port;
		},
		stop,
		shutdown,
	};
}

function restoreSeamDefaults(): void {
	setSkillPathClassifier(null);
	setSessionResourceCleanup(undefined);
	setAgentTitleHost(undefined);
	setWorkspaceToolsHost(undefined);
	setContinueToolHost(undefined);
	setContinuationPublisher(null);
	clearContinuations();
	setRequestReviewHandler(undefined);
	setResolveCommentHandler(undefined);
	setReviewFailedPublisher(() => {});
	setSessionResourcesPublisher(() => {});
	setMcpToolGrantWriter(undefined);
	setMcpProjectResolver(undefined);
	setMcpAuthorizationResolver(undefined);
	setMcpLoginPublisher(() => {});
	setMcpStatusPublisher(() => {});
	setSessionProjectResolver(() => null);
	setTerminalPublisher(() => "unavailable");
	setSearchTextPublisher(null);
	setProjectPublisher(null);
	setTerminalTabsPublisher(() => {});
	setWorkspacePublisher(null);
	setWorkspaceCreationPublisher(null);
	setWorkspaceCreationHandoff(null);
	setProjectPathGuard(null);
	setSpeechPublisher(null);
	setWatchPublisher(null);
	setIgnoredPathsResolver(null);
	setFsNudgePublisher(null);
	setWatchStartedPublisher(null);
	setRepoMetaPublisher(null);
	setReviewPublisher(() => {});
	setSettingsPublisher(null);
	setSessionCreatedPublisher(() => {});
	setSessionStatePublisher(() => {});
	setSessionDeletedPublisher(() => {});
	setTurnPublisher(() => {});
	setSessionPublisher(() => {});
	setExtUiPublisher(() => {});
}

async function serveStatic(pathname: string, staticDir: string): Promise<Response> {
	const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
	const requested = safe === "/" || safe === "" ? "index.html" : safe;
	const file = Bun.file(join(staticDir, requested));
	if (await file.exists()) return new Response(file);
	const index = Bun.file(join(staticDir, "index.html"));
	if (await index.exists()) return new Response(index);
	return new Response("not found", { status: 404 });
}

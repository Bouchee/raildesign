import {
	type PromptHit,
	type ResourceKind,
	sameModel,
	type TemplateInfo,
	type ThinkingLevel,
} from "@thinkrail/contracts";
import { t as translate, useT } from "@thinkrail/locales/react";
import { useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNow } from "@/components/useNow";
import { randomUuid } from "@/lib";
import { type ParsedTemplate, templateToSlashCommand, useTemplateCommandPicker } from "@/prompt";
import {
	EMPTY_RUNTIME,
	SettingsSection,
	selectCanRenameChat,
	selectCatalogModel,
	selectComposerFocusRequested,
	selectPickerModels,
	selectSkillsStale,
	selectWorkspaceById,
	toast,
	useAppStore,
	workspaceName,
} from "@/store";
import { errorText, getTransport, wsErrorCode } from "@/transport";
import { ChatHeader } from "./ChatHeader";
import ChatTranscript, { type ChatTranscriptHandle } from "./ChatTranscript";
import {
	Composer,
	type ComposerHandle,
	type ComposerSubmitDisposition,
	type MentionCandidate,
	type SubmitBehavior,
} from "./Composer";
import { mentionLookup } from "./fileTargets";
import { HistoryOverlay } from "./HistoryOverlay";
import { awaitingToolCallIdOf } from "./interactionState";
import { parseModelRef, RunModelLabel } from "./ModelEffortLabel";
import type { ModelSelection } from "./ModelEffortPicker";
import {
	mergeNativeChatCommands,
	parseNativeChatCommand,
	prepareNameChatCommand,
} from "./nativeCommands";
import type { PromptImagesOwner } from "./promptImages";
import { QueueStrip } from "./QueueStrip";
import { deriveRecentPrompts } from "./recentPrompts";
import {
	CommandLogView,
	newestResourceId,
	ResourcesAttention,
	ResourcesButton,
	ResourcesDock,
	ResourcesInspector,
	type ResourceTarget,
} from "./resources";
import { SkillsDialog } from "./SkillsDialog";
import { SubagentTranscriptDialog, SubagentTranscriptPane } from "./SubagentTranscriptDialog";
import { TemplateEditorDialog } from "./TemplateEditorDialog";
import { useChatResources, useCommandLog } from "./useChatResources";
import { inspectedResult, useFreshResults } from "./useFreshResults";
import { useModelCatalog } from "./useModelCatalog";
import { useModelPreferences } from "./useModelPreferences";
import { useSessionStats } from "./useSessionStats";
import "./tools/register";
import type { ChatAttachment } from "./types";
import { useHistorySearch } from "./useHistorySearch";

const TRY_AGAIN_PROMPT = "Try again.";
export default function ChatView({
	sessionId,
	workspaceId,
	onOpenFile,
}: {
	sessionId: string;
	workspaceId: string;
	onOpenFile?: ((path: string) => void) | undefined;
}) {
	const t = useT();
	const sessionExists = useAppStore((s) => s.sessions[sessionId] !== undefined);
	const isStreaming = useAppStore((s) => s.sessions[sessionId]?.isStreaming ?? false);
	const awaitingResponse = useAppStore(
		(s) => awaitingToolCallIdOf(s.sessions[sessionId]?.hostState ?? null) != null,
	);
	const draft = useAppStore((s) => s.sessions[sessionId]?.draft ?? "");
	const imageDraft = useAppStore(
		(s) => s.sessions[sessionId]?.promptImages ?? EMPTY_RUNTIME.promptImages,
	);
	const imageOwner = useMemo<PromptImagesOwner>(
		() => ({
			state: imageDraft,
			read: () =>
				useAppStore.getState().sessions[sessionId]?.promptImages ?? EMPTY_RUNTIME.promptImages,
			update: (change) => useAppStore.getState().updateChatPromptImages(sessionId, change),
		}),
		[imageDraft, sessionId],
	);
	const queue = useAppStore((s) => s.sessions[sessionId]?.queue ?? EMPTY_RUNTIME.queue);
	const sessionModel = useAppStore((s) => s.sessions[sessionId]?.model ?? null);
	const thinkingLevel = useAppStore(
		(s) => s.sessions[sessionId]?.thinkingLevel ?? EMPTY_RUNTIME.thinkingLevel,
	);
	const extUiStatus = useAppStore(
		(s) => s.sessions[sessionId]?.extUiStatus ?? EMPTY_RUNTIME.extUiStatus,
	);
	const extUiWidget = useAppStore(
		(s) => s.sessions[sessionId]?.extUiWidget ?? EMPTY_RUNTIME.extUiWidget,
	);
	const commands = useAppStore((s) => s.sessions[sessionId]?.commands ?? EMPTY_RUNTIME.commands);
	const stats = useAppStore((s) => s.sessions[sessionId]?.stats ?? null);
	const statsRefreshTick = useAppStore((s) => s.sessions[sessionId]?.statsRefreshTick ?? 0);
	const syncedConnectionGeneration = useAppStore(
		(s) => s.sessions[sessionId]?.syncedConnectionGeneration ?? 0,
	);
	const recentPrompts = useAppStore(
		useShallow((s) => deriveRecentPrompts(s.sessions[sessionId]?.turns ?? [])),
	);

	const status = useAppStore((s) => s.status);
	const connectionGeneration = useAppStore((s) => s.connectionGeneration);
	const canRenameChat = useAppStore(selectCanRenameChat);
	const composerGrowthLimit = useAppStore((state) => state.composerGrowthLimit);
	const questionPanelHeight = useAppStore((state) => state.questionPanelHeight);
	const [dockTarget, setDockTarget] = useState<HTMLDivElement | null>(null);
	const chatLineWidth = useAppStore((state) => state.chatLineWidth);
	const chatLineWidthBounded = useAppStore((state) => state.chatLineWidthBounded);
	const chatMessageOrder = useAppStore((state) => state.chatMessageOrder);
	const {
		models: allModels,
		refreshing: modelsRefreshing,
		refresh: onRefreshModels,
	} = useModelCatalog();
	const hiddenModels = useAppStore((s) => s.hiddenModels);
	const visibleModels = useMemo(
		() => selectPickerModels(allModels, hiddenModels, []),
		[allModels, hiddenModels],
	);
	const models = useMemo(
		() => selectPickerModels(allModels, hiddenModels, [sessionModel]),
		[allModels, hiddenModels, sessionModel],
	);
	const modelPreferences = useModelPreferences(visibleModels);
	const projectId = useAppStore(
		(s) =>
			Object.values(s.workspaces)
				.flat()
				.find((w) => w.id === workspaceId)?.projectId,
	);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [commandsRefreshTick, setCommandsRefreshTick] = useState(0);
	const skillsStale = useAppStore((s) => selectSkillsStale(s, workspaceId, sessionId));
	useEffect(() => {
		if (!sessionExists || status !== "connected") return;
		let active = true;
		getTransport()
			.request("session.getCommands", { sessionId })
			.then((available) => {
				const state = useAppStore.getState();
				if (
					active &&
					state.status === "connected" &&
					state.connectionGeneration === connectionGeneration &&
					state.sessions[sessionId]
				)
					state.setCommands(sessionId, available);
			})
			.catch((error: unknown) => {
				if (active && useAppStore.getState().connectionGeneration === connectionGeneration)
					toast.error(errorText(error));
			});
		return () => {
			active = false;
		};
	}, [
		sessionId,
		sessionExists,
		status,
		connectionGeneration,
		syncedConnectionGeneration,
		commandsRefreshTick,
	]);
	const resources = useChatResources(workspaceId, sessionId);
	const groups = resources.groups;
	const resourcesVisible = resources.visible;
	const now = useNow();
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [selectedResource, setSelectedResource] = useState<string | null>(null);
	const [transcriptChild, setTranscriptChild] = useState<string | null>(null);
	const [expandedResources, setExpandedResources] = useState<
		Partial<Record<ResourceKind, boolean>>
	>({});
	const {
		commands: freshCommands,
		subagents: freshSubagents,
		count: freshCount,
		markSeen,
	} = useFreshResults(workspaceId, sessionId, groups.recentFinished, resources.authoritative);
	const freshIds = new Set([
		...freshCommands.map((command) => command.id),
		...freshSubagents.map((child) => child.childSessionId),
	]);
	const selectedCommand = [...groups.commands, ...groups.finishedCommands].find(
		(command) => command.id === selectedResource,
	);
	const selectedChild = [...groups.subagents, ...groups.finishedSubagents].find(
		(child) => child.childSessionId === selectedResource,
	);
	const commandLog = useCommandLog(
		workspaceId,
		sessionId,
		inspectorOpen ? (selectedCommand ?? null) : null,
	);
	const selectResource = useCallback(
		(id: string) => {
			setSelectedResource(id);
			const target = inspectedResult(groups, id, id);
			if (target) markSeen(target);
		},
		[groups, markSeen],
	);
	const openResource = useCallback(
		(id: string | null) => {
			setExpandedResources({});
			setInspectorOpen(true);
			if (id) selectResource(id);
			else setSelectedResource(null);
		},
		[selectResource],
	);
	const openFinished = useCallback(
		() =>
			openResource(
				newestResourceId(freshCommands, freshSubagents) ??
					newestResourceId(groups.finishedCommands, groups.finishedSubagents),
			),
		[
			freshCommands,
			freshSubagents,
			groups.finishedCommands,
			groups.finishedSubagents,
			openResource,
		],
	);
	const resultOpener = useCallback(
		(target: ResourceTarget) => {
			const id = target.kind === "command" ? target.id : target.childSessionId;
			const available =
				target.kind === "command"
					? [...groups.commands, ...groups.finishedCommands].some((command) => command.id === id)
					: [...groups.subagents, ...groups.finishedSubagents].some(
							(child) => child.childSessionId === id,
						);
			return resourcesVisible && available ? () => openResource(id) : undefined;
		},
		[groups, resourcesVisible, openResource],
	);
	const openMcpSettings = useCallback(
		() => useAppStore.getState().openSettings(SettingsSection.Mcp),
		[],
	);
	const readMcpOutput = useCallback(
		(toolCallId: string) =>
			getTransport().request("mcp.readOutput", { workspaceId, sessionId, toolCallId }),
		[workspaceId, sessionId],
	);
	useEffect(() => {
		if (resources.knownUnsupported) setInspectorOpen(false);
	}, [resources.knownUnsupported]);
	const workspaceRoot = useAppStore(
		(s) => selectWorkspaceById(s, workspaceId)?.worktreePath ?? undefined,
	);
	const workspaces = useAppStore((s) => s.workspaces);
	const workspaceNames = useMemo(() => {
		const map: Record<string, string> = {};
		for (const list of Object.values(workspaces)) {
			for (const w of list) map[w.id] = workspaceName(t, w);
		}
		return map;
	}, [t, workspaces]);

	const currentModel = selectCatalogModel(models, sessionModel) ?? sessionModel;
	const refreshStats = useSessionStats({
		sessionId,
		statsRefreshTick,
		syncedConnectionGeneration,
		status,
		connectionGeneration,
		enabled: sessionExists,
	});

	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
	const [slashActive, setSlashActive] = useState(false);
	const [templates, setTemplates] = useState<TemplateInfo[]>([]);
	const [templatesEmpty, setTemplatesEmpty] = useState(false);
	const [saveAsTemplateHit, setSaveAsTemplateHit] = useState<PromptHit | null>(null);
	const composerRef = useRef<ComposerHandle>(null);
	const transcriptRef = useRef<ChatTranscriptHandle>(null);
	const openProviderSettings = useCallback(
		() => useAppStore.getState().openSettings(SettingsSection.Providers),
		[],
	);
	const findModel = useCallback(
		(ref: string) => selectCatalogModel(allModels, parseModelRef(ref)),
		[allModels],
	);
	const chatViewRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (element) {
				element.style.setProperty(
					"--chat-transcript-width",
					`calc(${chatLineWidth}ch + 2 * var(--chat-gutter))`,
				);
				element.style.setProperty("--question-panel-height", String(questionPanelHeight));
			}
		},
		[chatLineWidth, questionPanelHeight],
	);

	const {
		state: historyState,
		openOverlay,
		close: closeHistory,
		setQuery,
		cycleScope,
		setScope,
		toggleStage,
		moveSelection,
		openMessage,
	} = useHistorySearch(sessionId, workspaceId, projectId);
	useEffect(() => {
		useAppStore.getState().setChatObscured(sessionId, historyState.open);
		return () => useAppStore.getState().setChatObscured(sessionId, false);
	}, [historyState.open, sessionId]);

	useEffect(() => {
		if (!slashActive) return;
		let cancelled = false;
		getTransport()
			.request("template.list", { workspaceId })
			.then((res) => {
				if (cancelled) return;
				setTemplates(res.templates);
				setTemplatesEmpty(res.templates.length === 0);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [slashActive, workspaceId]);

	const mergedCommands = useMemo(
		() =>
			mergeNativeChatCommands(
				t,
				[
					...commands.filter((command) => command.source !== "prompt"),
					...templates.map(templateToSlashCommand),
				],
				canRenameChat,
			),
		[canRenameChat, commands, t, templates],
	);

	useEffect(() => {
		if (mentionQuery === null) {
			setMentionCandidates([]);
			return;
		}
		const { dir, prefix } = mentionLookup(mentionQuery);
		let cancelled = false;
		const timer = setTimeout(() => {
			getTransport()
				.request("fs.readDir", { workspaceId, path: dir })
				.then((nodes) => {
					if (cancelled) return;
					setMentionCandidates(
						nodes
							.filter((n) => n.name.toLowerCase().startsWith(prefix))
							.slice(0, 12)
							.map((n) => ({ path: n.path, name: n.name, kind: n.kind })),
					);
				})
				.catch(() => {
					if (!cancelled) setMentionCandidates([]);
				});
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [mentionQuery, workspaceId]);

	const onMentionQuery = useCallback((q: string | null) => setMentionQuery(q), []);

	const liveRuntime = () => useAppStore.getState().sessions[sessionId];
	const pairSelection = useRef(0);

	const requestLevel = useCallback(
		(level: ThinkingLevel, previous: ThinkingLevel) =>
			getTransport()
				.request("session.setThinkingLevel", { sessionId, level })
				.catch((error: unknown) => {
					if (useAppStore.getState().sessions[sessionId]?.thinkingLevel === level) {
						useAppStore.getState().setThinkingLevel(sessionId, previous);
					}
					toast.error(errorText(error), translate("chat.view.effortChangeFailed"));
				}),
		[sessionId],
	);

	useEffect(() => {
		if (!currentModel || currentModel.thinkingLevels.includes(thinkingLevel)) return;
		let cancelled = false;
		getTransport()
			.request("model.clampThinking", {
				provider: currentModel.provider,
				id: currentModel.id,
				level: thinkingLevel,
			})
			.then((clamped) => {
				if (cancelled || clamped.level === thinkingLevel) return;
				pairSelection.current += 1;
				useAppStore.getState().setThinkingLevel(sessionId, clamped.level);
				return requestLevel(clamped.level, thinkingLevel);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [currentModel, thinkingLevel, sessionId, requestLevel]);

	const onSelectThinking = (level: ThinkingLevel) => {
		if (level === thinkingLevel) return;
		pairSelection.current += 1;
		useAppStore.getState().setThinkingLevel(sessionId, level);
		void requestLevel(level, thinkingLevel);
	};

	const onSelectModel = ({ model, level }: ModelSelection) => {
		if (sameModel(model, currentModel)) {
			if (level) onSelectThinking(level);
			return;
		}
		const previous = { model: sessionModel, level: thinkingLevel };
		const selection = ++pairSelection.current;
		const superseded = () => selection !== pairSelection.current;
		useAppStore.getState().setCurrentModel(sessionId, model);
		if (level) useAppStore.getState().setThinkingLevel(sessionId, level);
		void getTransport()
			.request("session.setModel", { sessionId, model })
			.then(
				() => (level && !superseded() ? requestLevel(level, previous.level) : undefined),
				(error: unknown) => {
					if (sameModel(liveRuntime()?.model, model)) {
						if (previous.model) useAppStore.getState().setCurrentModel(sessionId, previous.model);
						if (level && !superseded()) {
							useAppStore.getState().setThinkingLevel(sessionId, previous.level);
						}
					}
					toast.error(
						errorText(error),
						translate("chat.view.modelSwitchFailed", { model: model.name }),
					);
				},
			)
			.then(() => refreshStats());
	};

	const performRename = (title: string) => {
		void getTransport()
			.request("session.rename", { workspaceId, sessionId, title })
			.catch((err) => useAppStore.getState().appendErrorTurn(sessionId, errorText(err)));
	};

	const performSend = (text: string, attachments: ChatAttachment[], behavior: SubmitBehavior) => {
		const streaming = useAppStore.getState().sessions[sessionId]?.isStreaming ?? false;
		const mode = behavior === "send" && streaming ? "steer" : behavior;
		const messageId = randomUuid();
		if (mode === "send" && (text || attachments.length > 0)) {
			transcriptRef.current?.armImmediateTurn();
			useAppStore.getState().appendUserMessage(sessionId, text, attachments, messageId);
		}
		const images = attachments.map((a) => a.content);
		const params = { sessionId, text, messageId, ...(images.length > 0 ? { images } : {}) };
		const transport = getTransport();
		const sent =
			mode === "interrupt"
				? transport
						.request("session.abort", { sessionId })
						.then(() => transport.request("session.prompt", params))
				: transport.request(
						mode === "steer"
							? "session.steer"
							: mode === "followUp"
								? "session.followUp"
								: "session.prompt",
						params,
					);
		void sent.catch((err) => {
			useAppStore.getState().appendErrorTurn(sessionId, errorText(err));
			const runtime = useAppStore.getState().sessions[sessionId];
			const retained = [
				...(runtime?.queue.steering ?? []),
				...(runtime?.queue.followUp ?? []),
			].some((item) => item.id === messageId);
			// The host refuses a message over the WebSocket frame cap; give it back to edit.
			const tooLarge = wsErrorCode(err) === "FRAME_TOO_LARGE";
			if (!retained && (mode !== "send" || tooLarge)) {
				const currentDraft = runtime?.draft ?? "";
				useAppStore
					.getState()
					.setChatDraft(sessionId, [text, currentDraft].filter(Boolean).join("\n\n"));
				composerRef.current?.restoreAttachments(attachments);
			}
			transcriptRef.current?.cancelImmediateTurn(runtime?.isStreaming ?? false);
		});
	};

	const onSubmit = (
		text: string,
		attachments: ChatAttachment[],
		behavior: SubmitBehavior,
	): ComposerSubmitDisposition => {
		const nativeCommand = parseNativeChatCommand(text, canRenameChat);
		if (nativeCommand?.kind === "name") {
			const prepared = prepareNameChatCommand(nativeCommand.title, attachments.length > 0);
			if ("reason" in prepared) return { accepted: false, reason: prepared.reason };
			performRename(prepared.title);
			return { accepted: true };
		}
		if (nativeCommand?.kind === "compact") {
			if (attachments.length > 0)
				return { accepted: false, reason: t("chat.commands.compactImageError") };
			if (isStreaming) return { accepted: false, reason: t("chat.view.runInProgress") };
			void getTransport()
				.request("session.compact", {
					sessionId,
					operationId: randomUuid(),
					instructions: nativeCommand.instructions,
				})
				.catch((error: unknown) =>
					toast.error(errorText(error), translate("chat.compaction.failed")),
				);
			return { accepted: true };
		}
		performSend(text, attachments, behavior);
		return { accepted: true };
	};

	const onAbort = () => {
		void getTransport()
			.request("session.abort", { sessionId })
			.catch((error: unknown) => toast.error(errorText(error)));
	};

	const removeQueued = (messageId: string, edit: boolean) => {
		void getTransport()
			.request("session.removeQueued", { sessionId, messageId })
			.then(({ removed }) => {
				if (!edit || !removed) return;
				const currentDraft = useAppStore.getState().sessions[sessionId]?.draft ?? "";
				useAppStore
					.getState()
					.setChatDraft(sessionId, [removed.text, currentDraft].filter(Boolean).join("\n\n"));
				composerRef.current?.restoreAttachments(
					(removed.images ?? []).map((content, index) => ({
						name: t("chat.queue.imageName", { index: index + 1 }),
						content,
					})),
				);
				composerRef.current?.refocus();
			})
			.catch((error: unknown) => toast.error(errorText(error)));
	};

	const onDismissHistory = () => {
		closeHistory();
		composerRef.current?.refocus();
	};

	const onHistoryOutsidePress = () => {
		closeHistory();
		setTimeout(() => {
			if (document.activeElement === document.body) composerRef.current?.refocus();
		});
	};

	const onHistoryOpen = () => (historyState.open ? onDismissHistory() : openOverlay(draft));

	const onManageTemplates = () => useAppStore.getState().openSettings(SettingsSection.Templates);

	const onInsertHit = (hit: PromptHit) => {
		composerRef.current?.insertText(hit.text);
		closeHistory();
	};

	const onInsertAndSendHit = (hit: PromptHit) => {
		composerRef.current?.insertAndSubmit(hit.text, isStreaming ? "followUp" : "send");
		closeHistory();
	};

	const onSaveAsTemplateHit = (hit: PromptHit) => {
		closeHistory();
		setSaveAsTemplateHit(hit);
	};

	const onDeleteHistoryChat = async (targetWorkspaceId: string, targetSessionId: string) => {
		try {
			await getTransport().request("session.delete", {
				workspaceId: targetWorkspaceId,
				sessionId: targetSessionId,
			});
			closeHistory();
			useAppStore.getState().deleteChat(targetWorkspaceId, targetSessionId);
		} catch (err) {
			toast.error(errorText(err), translate("chat.view.deleteFailed"));
		}
	};

	const loadTemplate = useCallback(
		(name: string) => getTransport().request("template.get", { workspaceId, name }),
		[workspaceId],
	);
	const applyTemplate = useCallback(
		(template: ParsedTemplate) => composerRef.current?.insertTemplate(template),
		[],
	);
	const { pending: templatePending, pick: onPickTemplate } = useTemplateCommandPicker({
		draft,
		contextKey: `${workspaceId}:${sessionId}`,
		load: loadTemplate,
		onApply: applyTemplate,
	});

	const historyOpenRequest = useAppStore((s) => s.historyOpenRequest);
	const historyOverlayOpen = historyState.open;
	useEffect(() => {
		if (historyOpenRequest?.sessionId !== sessionId) return;
		if (useAppStore.getState().historyOpenRequest !== historyOpenRequest) return;
		useAppStore.getState().clearHistoryOpen();
		if (historyOverlayOpen) cycleScope();
		else composerRef.current?.openHistory();
	}, [historyOpenRequest, sessionId, historyOverlayOpen, cycleScope]);

	const composerFocusRequested = useAppStore((s) =>
		selectComposerFocusRequested(s, workspaceId, sessionId),
	);
	useEffect(() => {
		if (!composerFocusRequested) return;
		useAppStore.getState().clearComposerFocusRequest();
		composerRef.current?.refocus();
	}, [composerFocusRequested]);

	const widgetEntries = Object.entries(extUiWidget);
	const focusComposer = useCallback(() => composerRef.current?.refocus(), []);
	// Keep a stable `onTryAgain` identity (it is passed to every transcript row) while always calling the
	// latest `performSend` closure.
	const performSendRef = useRef(performSend);
	useInsertionEffect(() => {
		performSendRef.current = performSend;
	});
	const onTryAgain = useCallback(() => performSendRef.current(TRY_AGAIN_PROMPT, [], "send"), []);

	return (
		<div
			ref={chatViewRef}
			data-testid="chat-view"
			data-line-width-bounded={chatLineWidthBounded}
			data-message-order={chatMessageOrder}
			className="flex h-full min-h-0 min-w-0 flex-col bg-container-workspace-bg [container-type:size]"
		>
			<div className="shrink-0">
				<ChatHeader
					stats={stats}
					statusEntries={Object.entries(extUiStatus)}
					skillsStale={skillsStale}
					resources={
						resourcesVisible ? (
							<>
								<ResourcesButton
									activeCount={
										resources.authoritative ? groups.activeCount + groups.mcpActiveCount : null
									}
									freshCount={freshCount}
									open={inspectorOpen}
									working={groups.activeCount > 0}
									onClick={() => (inspectorOpen ? setInspectorOpen(false) : openResource(null))}
								/>
								{groups.mcpAttentionCount > 0 ? (
									<ResourcesAttention count={groups.mcpAttentionCount} onOpen={openMcpSettings} />
								) : null}
							</>
						) : null
					}
					{...(projectId ? { onOpenSkills: () => setSkillsOpen(true) } : {})}
				/>
			</div>
			<ChatTranscript
				ref={transcriptRef}
				sessionId={sessionId}
				workspaceId={workspaceId}
				onOpenFile={onOpenFile}
				workspaceRoot={workspaceRoot}
				focusComposer={focusComposer}
				onTryAgain={onTryAgain}
				historyOpen={historyState.open}
				inspectorOpen={inspectorOpen}
				stillRunning={
					resourcesVisible && groups.activeCount > 0
						? { count: groups.activeCount, onOpen: () => openResource(null) }
						: undefined
				}
				resultOpener={resultOpener}
				markResultSeen={markSeen}
				openSubagentTranscript={setTranscriptChild}
				readMcpOutput={readMcpOutput}
				openMcpSettings={openMcpSettings}
				resourcesOverlay={
					resourcesVisible ? (
						<ResourcesInspector
							open={inspectorOpen}
							onOpenChange={setInspectorOpen}
							onCloseAutoFocus={(event) => {
								event.preventDefault();
								focusComposer();
							}}
							commands={groups.commands}
							subagents={groups.subagents}
							finishedCommands={groups.finishedCommands}
							finishedSubagents={groups.finishedSubagents}
							history={groups.history}
							remaining={groups.remaining}
							newIds={freshIds}
							expanded={expandedResources}
							onExpandedChange={(kind, expanded) =>
								setExpandedResources((current) => ({ ...current, [kind]: expanded }))
							}
							{...(resources.loadOlder ? { onLoadMore: resources.loadOlder } : {})}
							retained={resources.retained}
							now={now}
							authoritative={resources.authoritative}
							loading={resources.loading}
							staleness={resources.staleness}
							error={resources.projection?.error ?? null}
							actions={resources.actions}
							selectedId={selectedResource}
							onSelect={selectResource}
							onRetry={resources.retry}
							onStopCommand={resources.stopCommand}
							onStopSubagent={resources.stopSubagent}
							onStopAll={resources.stopAll}
							renderSubagentModel={(child) => (
								<RunModelLabel model={child.model} thinkingLevel={child.thinkingLevel} />
							)}
							mcpServers={groups.mcpServers}
							onMcpSetEnabled={resources.setMcpEnabled}
							onMcpReconnect={resources.reconnectMcp}
							onOpenMcpSettings={openMcpSettings}
							detail={
								selectedCommand ? (
									<CommandLogView
										{...commandLog}
										onRetry={commandLog.retry}
										interrupted={selectedCommand.interrupted ?? false}
										retained={resources.retained}
									/>
								) : selectedChild ? (
									<SubagentTranscriptPane
										workspaceId={workspaceId}
										parentSessionId={sessionId}
										childSessionId={selectedChild.childSessionId}
									/>
								) : null
							}
						/>
					) : null
				}
				openProviderSettings={openProviderSettings}
				findModel={findModel}
				dockTarget={dockTarget}
			/>
			<div
				ref={setDockTarget}
				data-testid="chat-dock"
				className="flex max-h-[calc(var(--question-panel-height)*1cqh)] min-h-0 flex-col"
			/>
			{widgetEntries.length > 0 ? (
				<div className="shrink-0 border-border-default border-t bg-container-elevated-bg px-12 py-4 text-text-muted tr-text-metadata">
					{widgetEntries.map(([key, lines]) => (
						<div key={key}>{lines.join(" ")}</div>
					))}
				</div>
			) : null}
			<QueueStrip
				queue={queue}
				onEdit={(id) => void removeQueued(id, true)}
				onRemove={(id) => void removeQueued(id, false)}
			/>
			{resourcesVisible && !inspectorOpen ? (
				<ResourcesDock
					commands={groups.commands}
					subagents={groups.subagents}
					finishedCount={groups.finishedCount}
					freshCount={freshCount}
					now={now}
					authoritative={resources.authoritative}
					staleness={resources.staleness}
					actions={resources.actions}
					onInspect={openResource}
					onOpenFinished={openFinished}
					onStopCommand={resources.stopCommand}
					onStopSubagent={resources.stopSubagent}
				/>
			) : null}
			<div className="relative shrink-0">
				<HistoryOverlay
					state={historyState}
					workspaceNames={workspaceNames}
					onQueryChange={setQuery}
					onSetScope={setScope}
					onToggleStage={toggleStage}
					onMoveSelection={moveSelection}
					onClose={onDismissHistory}
					onOutsidePress={onHistoryOutsidePress}
					onInsert={onInsertHit}
					onInsertAndSend={onInsertAndSendHit}
					onOpenMessage={openMessage}
					onSaveAsTemplate={onSaveAsTemplateHit}
					onDeleteChat={(wsId, id) => void onDeleteHistoryChat(wsId, id)}
					canDeleteChat={(wsId) =>
						selectWorkspaceById(useAppStore.getState(), wsId)?.kind !== "chat"
					}
				/>
				<Composer
					ref={composerRef}
					value={draft}
					onChange={(v) => useAppStore.getState().setChatDraft(sessionId, v)}
					imageOwner={imageOwner}
					isStreaming={isStreaming}
					awaitingResponse={awaitingResponse}
					growthLimit={composerGrowthLimit}
					commands={mergedCommands}
					templatePending={templatePending}
					mentionCandidates={mentionCandidates}
					recentPrompts={recentPrompts}
					models={models}
					modelsRefreshing={modelsRefreshing}
					onRefreshModels={onRefreshModels}
					currentModel={currentModel}
					thinkingLevel={thinkingLevel}
					modelPreferences={modelPreferences}
					onMentionQuery={onMentionQuery}
					onSlashActive={setSlashActive}
					onSelectModel={onSelectModel}
					onSelectThinking={onSelectThinking}
					onSubmit={onSubmit}
					onAbort={onAbort}
					onHistoryOpen={onHistoryOpen}
					onPickTemplate={onPickTemplate}
					onManageTemplates={onManageTemplates}
					templatesEmpty={templatesEmpty}
				/>
			</div>
			{transcriptChild ? (
				<SubagentTranscriptDialog
					workspaceId={workspaceId}
					parentSessionId={sessionId}
					childSessionId={transcriptChild}
					onOpenChange={(open) => {
						if (!open) setTranscriptChild(null);
					}}
				/>
			) : null}
			{projectId ? (
				<SkillsDialog
					projectId={projectId}
					workspace={{
						workspaceId,
						sessionId,
						streaming: isStreaming,
						stale: skillsStale,
						onReloaded: (tick) => {
							useAppStore.getState().markSkillsSynced(sessionId, tick);
							setCommandsRefreshTick((current) => current + 1);
						},
					}}
					open={skillsOpen}
					onOpenChange={setSkillsOpen}
				/>
			) : null}
			<TemplateEditorDialog
				open={saveAsTemplateHit != null}
				onOpenChange={(open) => {
					if (!open) setSaveAsTemplateHit(null);
				}}
				workspaceId={workspaceId}
				initialBody={saveAsTemplateHit?.text ?? ""}
			/>
		</div>
	);
}

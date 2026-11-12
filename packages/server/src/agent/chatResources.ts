import {
	type BackgroundCommandStatus,
	type BackgroundCommandSummary,
	compareResourceHistory,
	isLiveResource,
	RESOURCE_HISTORY_MAX_PAGE_LIMIT,
	RESOURCE_HISTORY_PAGE_LIMIT,
	type ResourceHistoryCursor,
	type ResourceHistoryPage,
	type ResourceKind,
	type ResourceRecord,
	resourceHistoryCursor,
	resourceRecordId,
	type SessionResources,
	type SubagentResourceSummary,
	tallyResources,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type { BackgroundCommands } from "pi-background-commands";
import type { ChildHandle, DelegationService, LifecycleEvent } from "pi-delegation";
import {
	finishedResources,
	pageResources,
	type ResourceHistoryScope,
	recordResource,
} from "../resourceHistory";
import { INTERRUPTED_ABORT_REASON } from "./delegation";
import { isHostResourceId } from "./resourceIdentity";

function unavailable(): CodedError {
	return new CodedError("RESOURCE_UNAVAILABLE", "Resource unavailable");
}
function assertScope(scope: ResourceHistoryScope): void {
	if (!isHostResourceId(scope.workspaceId) || !isHostResourceId(scope.sessionId))
		throw unavailable();
}
function inScope(record: ResourceRecord, scope: ResourceHistoryScope): boolean {
	return (
		isHostResourceId(resourceRecordId(record)) &&
		(record.kind === "command"
			? record.summary.sessionId === scope.sessionId
			: record.summary.parentSessionId === scope.sessionId)
	);
}

export function subagentSummary(
	{ record, snapshot }: Pick<ChildHandle, "record" | "snapshot">,
	parentSessionId: string,
): SubagentResourceSummary | undefined {
	if (!snapshot) return undefined;
	const live = snapshot.status === "running" || snapshot.status === "queued";
	return {
		childSessionId: record.sessionId,
		parentSessionId,
		...(record.info.roleName !== undefined ? { roleName: record.info.roleName.slice(0, 200) } : {}),
		task: snapshot.task.slice(0, 2000),
		status: snapshot.status,
		createdAt: record.createdAt,
		...(record.info.detached === true ? { detached: true } : {}),
		...(snapshot.details.model !== undefined ? { model: snapshot.details.model } : {}),
		...(snapshot.details.thinkingLevel !== undefined
			? { thinkingLevel: snapshot.details.thinkingLevel }
			: {}),
		...(snapshot.details.abortReason !== undefined
			? { abortReason: snapshot.details.abortReason }
			: {}),
		...(live ? {} : { durationMs: snapshot.details.durationMs }),
	};
}

export function ownedChildResources(
	service: Pick<DelegationService, "childrenOf">,
	scope: ResourceHistoryScope,
): ResourceRecord[] {
	assertScope(scope);
	return service.childrenOf(scope.sessionId).flatMap((child): ResourceRecord[] => {
		if (
			child.record.scope !== scope.workspaceId ||
			child.record.parentSessionId !== scope.sessionId ||
			!isHostResourceId(child.sessionId)
		)
			return [];
		const summary = subagentSummary(child, scope.sessionId);
		return summary ? [{ kind: "subagent", summary }] : [];
	});
}

/** Caller must first authorize the scope. Merge supplied owner snapshots with the application archive. */
export function resourceHistoryOf(
	scope: ResourceHistoryScope,
	kind: ResourceKind,
	current: readonly ResourceRecord[],
) {
	assertScope(scope);
	const owned = current.filter((record) => record.kind === kind && inScope(record, scope));
	const live = owned.filter(isLiveResource);
	const settled = new Map(
		owned
			.filter((record) => !isLiveResource(record))
			.map((record) => [resourceRecordId(record), record]),
	);
	const finished = finishedResources(scope, kind, new Set(live.map(resourceRecordId)))
		.filter((record) => inScope(record, scope))
		.map(
			(record) => (record.summary.interrupted && settled.get(resourceRecordId(record))) || record,
		);
	const archived = new Set(finished.map(resourceRecordId));
	for (const [id, record] of settled) if (!archived.has(id)) finished.push(record);
	finished.sort((a, b) =>
		compareResourceHistory(resourceHistoryCursor(a), resourceHistoryCursor(b)),
	);
	return { live, finished };
}
function commandSummaries(records: readonly ResourceRecord[]): BackgroundCommandSummary[] {
	return records.flatMap((record) => (record.kind === "command" ? [record.summary] : []));
}
function subagentSummaries(records: readonly ResourceRecord[]): SubagentResourceSummary[] {
	return records.flatMap((record) => (record.kind === "subagent" ? [record.summary] : []));
}

export function getSessionResources(
	scope: ResourceHistoryScope,
	current: readonly ResourceRecord[],
): SessionResources {
	const command = resourceHistoryOf(scope, "command", current);
	const subagent = resourceHistoryOf(scope, "subagent", current);
	const window = (history: ReturnType<typeof resourceHistoryOf>) => [
		...history.live,
		...history.finished.slice(0, RESOURCE_HISTORY_PAGE_LIMIT),
	];
	return {
		workspaceId: scope.workspaceId,
		sessionId: scope.sessionId,
		commands: commandSummaries(window(command)),
		subagents: subagentSummaries(window(subagent)),
		history: {
			commands: tallyResources(command.finished),
			subagents: tallyResources(subagent.finished),
		},
	};
}

export function getResourceHistoryPage(
	scope: ResourceHistoryScope,
	current: readonly ResourceRecord[],
	request: { kind: ResourceKind; before?: ResourceHistoryCursor; limit?: number },
): ResourceHistoryPage {
	const requested = request.limit ?? RESOURCE_HISTORY_PAGE_LIMIT;
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(Math.trunc(requested), 1), RESOURCE_HISTORY_MAX_PAGE_LIMIT)
		: RESOURCE_HISTORY_PAGE_LIMIT;
	const page = pageResources(
		resourceHistoryOf(scope, request.kind, current).finished,
		request.before,
		limit,
	);
	return request.kind === "command"
		? { kind: "command", items: commandSummaries(page.items), hasMore: page.hasMore }
		: { kind: "subagent", items: subagentSummaries(page.items), hasMore: page.hasMore };
}

export function archiveCommandHistory(
	workspaceId: string,
	sessionId: string,
	commands: Pick<BackgroundCommands, "sessionId" | "list" | "find" | "onChange">,
	closing: () => boolean,
): { finish: () => void } {
	const scope = { workspaceId, sessionId };
	assertScope(scope);
	if (commands.sessionId !== sessionId) throw unavailable();
	const recorded = new Map<string, BackgroundCommandStatus>();
	const requestedStops = new Set<string>();
	let finished = false;
	const sync = () => {
		if (finished) return;
		const listed = new Set<string>();
		for (const snapshot of commands.list()) {
			if (snapshot.sessionId !== sessionId || !isHostResourceId(snapshot.id)) continue;
			listed.add(snapshot.id);
			if (recorded.get(snapshot.id) === snapshot.status) continue;
			recorded.set(snapshot.id, snapshot.status);
			if (snapshot.status === "stopping" && !closing()) requestedStops.add(snapshot.id);
			const cutOff = snapshot.status === "stopped" && closing() && !requestedStops.has(snapshot.id);
			const record: ResourceRecord = {
				kind: "command",
				summary: cutOff ? { ...snapshot, interrupted: true } : snapshot,
			};
			recordResource(
				scope,
				record,
				isLiveResource(record) ? undefined : commands.find(snapshot.id)?.output,
			);
		}
		for (const id of recorded.keys()) {
			if (listed.has(id)) continue;
			recorded.delete(id);
			requestedStops.delete(id);
		}
	};
	const unsubscribe = commands.onChange(sync);
	sync();
	return {
		finish: () => {
			sync();
			finished = true;
			unsubscribe();
			for (const snapshot of commands.list()) {
				if (snapshot.sessionId !== sessionId || !isHostResourceId(snapshot.id)) continue;
				if (!isLiveResource({ kind: "command", summary: snapshot })) continue;
				recordResource(
					scope,
					{ kind: "command", summary: { ...snapshot, interrupted: true } },
					commands.find(snapshot.id)?.output,
				);
			}
		},
	};
}

export function archiveSubagentRun(
	workspaceId: string,
	service: Pick<DelegationService, "findChild">,
	event: LifecycleEvent,
): void {
	if (event.type !== "run-queued" && event.type !== "run-started" && event.type !== "run-terminal")
		return;
	const child = service.findChild(event.sessionId);
	if (
		!child ||
		child.record.scope !== workspaceId ||
		child.record.parentSessionId !== event.parentSessionId
	)
		return;
	const scope = { workspaceId, sessionId: event.parentSessionId };
	assertScope(scope);
	if (!isHostResourceId(child.sessionId)) return;
	const summary = subagentSummary(child, event.parentSessionId);
	if (!summary) return;
	const terminal = event.type === "run-terminal";
	const cutOff =
		terminal && summary.status === "aborted" && summary.abortReason === INTERRUPTED_ABORT_REASON;
	recordResource(
		{ workspaceId, sessionId: event.parentSessionId },
		{
			kind: "subagent",
			summary: {
				...summary,
				...(terminal ? { finishedAt: Date.now() } : {}),
				...(cutOff ? { interrupted: true } : {}),
			},
		},
	);
}

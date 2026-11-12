import type { DelegationRunDetails, DelegationRunStatus } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

export interface ChildHandle {
	sessionId: string;
	record: {
		sessionId: string;
		scope?: string;
		parentSessionId?: string;
		createdAt: string;
		info: { roleName?: string; detached?: boolean };
	};
	snapshot?:
		| { status: DelegationRunStatus; task: string; details: DelegationRunDetails }
		| undefined;
	abort(reason: string): Promise<void>;
	dispose(): Promise<void>;
}
export interface DelegationService {
	findChild(id: string): ChildHandle | undefined;
	childrenOf(parentSessionId: string): ChildHandle[];
}
export interface LifecycleEvent {
	type: string;
	sessionId: string;
	parentSessionId: string;
}

export const INTERRUPTED_ABORT_REASON = "interrupted";

/** The caller supplies its active service; this module never constructs a runtime or child executor. */
export function ownedChild(
	service: Pick<DelegationService, "findChild">,
	workspaceId: string,
	parentSessionId: string,
	childSessionId: string,
): ChildHandle {
	const child = service.findChild(childSessionId);
	if (
		!child ||
		child.record.scope !== workspaceId ||
		child.record.parentSessionId !== parentSessionId
	)
		throw new CodedError("RESOURCE_UNAVAILABLE", "Resource unavailable");
	return child;
}

export function liveSessionChildren(
	service: Pick<DelegationService, "childrenOf">,
	workspaceId: string,
	parentSessionId: string,
): ChildHandle[] {
	return service
		.childrenOf(parentSessionId)
		.filter(
			(child) =>
				child.record.scope === workspaceId &&
				child.record.parentSessionId === parentSessionId &&
				(child.snapshot?.status === "queued" || child.snapshot?.status === "running"),
		);
}

export function hasLiveSessionChildren(
	service: Pick<DelegationService, "childrenOf">,
	workspaceId: string,
	parentSessionId: string,
): boolean {
	return liveSessionChildren(service, workspaceId, parentSessionId).length > 0;
}

/** Cancellation starts before return. Settlement waits for every owned run and surfaces cleanup failures. */
export function stopSessionChildren(
	service: Pick<DelegationService, "childrenOf">,
	workspaceId: string,
	parentSessionId: string,
	reason: string,
): { stopped: number; settled: Promise<void> } {
	const children = liveSessionChildren(service, workspaceId, parentSessionId);
	const pending = children.map((child) => {
		let abort: Promise<void>;
		try {
			abort = child.abort(reason);
		} catch (error) {
			abort = Promise.reject(error);
		}
		return abort.catch(() => child.dispose());
	});
	const settled = Promise.allSettled(pending).then((results) => {
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) throw new AggregateError(failures, "Child cleanup failed");
	});
	return { stopped: children.length, settled };
}

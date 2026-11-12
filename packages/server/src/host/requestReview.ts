import { isDeepStrictEqual } from "node:util";
import type {
	PlanReviewResult,
	ReviewComment,
	ReviewFailedPayload,
	ReviewFixComment,
	TodoPlan,
} from "@thinkrail/contracts";
import { isPlanReviewResult } from "@thinkrail/contracts";
import type { Todo } from "@thinkrail/todos/core";
import {
	acquireSessionReviewScope,
	clampThinkingForModel,
	getSessionWorkspaceId,
	notifyExtUi,
	runSessionChild,
	sendReviewFixToSession,
	setRequestReviewHandler,
	setResolveCommentHandler,
} from "../agent";
import { gitDiffFile, gitStatus } from "../git";
import { logger } from "../log";
import {
	addComment,
	anchorProblem,
	buildReviewFixDetails,
	buildSendPackage,
	deleteComment,
	getReviewSnapshot,
	markCommentsSent,
	publishReview,
	resolveCommentFromAgent,
	rollbackSend,
	setReviewGuide,
} from "../reviews";
import { getConfig } from "../settings";
import {
	approveTodoReview,
	cancelTodoReview,
	listTodos,
	recordAgentChangesRequested,
	renderFixPackage,
	requestTodoFix,
	rollbackTodoFix,
	settleChangeArtifacts,
	startTodoReview,
	todoReviewAutoCycles,
	todoReviewRecord,
} from "../todos";
import { recordWorkspaceActivity } from "../workspaces";
import { resolveNewChatModel } from "./newChatModel";
import {
	claimItemReview,
	onPlanChain,
	planReviewRunning,
	releaseItemReview,
} from "./planReviewQueue";

import { REVIEWER_OUTPUT_CONTRACT, REVIEWER_SYSTEM_PROMPT, REVIEWER_TOOLS } from "./reviewerRole";
import { withReviewLock } from "./reviewLock";
import {
	claimItemFix,
	clearChangesRequestedIfResolved,
	itemFixFindings,
	itemOpenFindings,
	releaseItemFix,
} from "./todoReview";

const log = logger("review");
const DEFAULT_FIX_NOTE = "Address the reviewer's findings below.";
let reviewFailedPublisher: (payload: ReviewFailedPayload) => void = () => {};
export function setReviewFailedPublisher(fn: typeof reviewFailedPublisher): void {
	reviewFailedPublisher = fn;
}
type ReviewParams = { workspaceId: string; sessionId: string; id: string };

export async function itemTitleOf(
	workspaceId: string,
	sessionId: string,
	itemId: string,
	readPlan: (params: { workspaceId: string; sessionId: string }) => Promise<TodoPlan> = listTodos,
): Promise<string> {
	const plan = await readPlan({ workspaceId, sessionId });
	const items = [
		...plan.todos,
		...plan.groups.flatMap((group) => group.todos),
		...(plan.adoptedCommits ?? []),
	];
	return items.find((item) => item.id === itemId)?.title ?? itemId;
}

function agentPath(path: string): string {
	return path.replaceAll("\\", "/");
}

export function parseVerdict(
	finalText: string | undefined,
	itemId: string,
	itemTitle: string,
): PlanReviewResult | null {
	if (!finalText) return null;
	const fenced = /```json\s*([\s\S]*?)```/gi.exec(finalText);
	const raw = fenced?.[1] ?? finalText;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = { ...parsed, itemId, itemTitle };
	if (!isPlanReviewResult(candidate)) return null;
	const findings: ReviewFixComment[] = candidate.findings.map((f) => ({
		id: f.id,
		kind: f.kind ?? "inline",
		body: f.body,
		...(f.path ? { path: agentPath(f.path) } : {}),
		...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
		...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
	}));
	return {
		verdict: candidate.verdict,
		itemId,
		itemTitle,
		...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
		...(candidate.readingOrder !== undefined
			? {
					readingOrder: candidate.readingOrder.map((step) => ({
						path: agentPath(step.path),
						why: step.why,
					})),
				}
			: {}),
		findings,
	};
}

export type VerdictOutcome =
	| { kind: "approved" }
	| { kind: "approve-blocked"; openFindings: number }
	| { kind: "changes"; canAutoFix: boolean; findings?: ReviewFixComment[] };

type RecordedVerdict = VerdictOutcome & { deliverFix?: () => Promise<void> };

export function composeText(result: PlanReviewResult, outcome: VerdictOutcome): string {
	const list = outcome.kind === "changes" ? (outcome.findings ?? result.findings) : result.findings;
	const findings =
		list.length > 0
			? `\n\n${list
					.map((f) => {
						const loc = f.path
							? ` (${f.path}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ""}` : ""})`
							: "";
						return `- [${f.id}]${loc} ${f.body}`;
					})
					.join("\n")}`
			: "";
	const rationale = result.summary ? `\n\n${result.summary}` : "";
	if (outcome.kind === "approved") {
		return `Review verdict: APPROVE — step "${result.itemTitle}".${rationale}${findings}`;
	}
	if (outcome.kind === "approve-blocked") {
		const n = outcome.openFindings;
		return (
			`Review verdict: APPROVE — step "${result.itemTitle}" — but it is NOT settled: ` +
			`${n} earlier finding${n === 1 ? "" : "s"} on this step ${n === 1 ? "is" : "are"} still open in Review. ` +
			`Resolve each one you actually addressed with resolve_comment, then request_review again.${rationale}${findings}`
		);
	}
	const head = `Review verdict: REQUEST_CHANGES — step "${result.itemTitle}".`;
	const next = outcome.canAutoFix
		? "Fix each finding below NOW without asking the user: set the step back to in_progress (todo_update), apply the fixes, mark it done, then call request_review again."
		: "The automated fix cycle is spent or auto-fix is off: do NOT fix now. Report these findings to the user and wait for their direction.";
	return `${head} ${next}${rationale}${findings}`;
}

async function reviewChangeSet(params: ReviewParams): Promise<string> {
	const plan = await listTodos(params);
	const item = [
		...plan.todos,
		...plan.groups.flatMap((group) => group.todos),
		...(plan.adoptedCommits ?? []),
	].find((candidate) => candidate.id === params.id);
	if (!item) throw new Error("The reviewed Plan step no longer exists");
	const files: Array<{ path: string; scope: import("@thinkrail/contracts").GitDiffScope }> = [];
	for (const artifact of item.artifacts ?? []) {
		if (artifact.kind === "commit" && artifact.sha) {
			const scope = { kind: "commit" as const, sha: artifact.sha };
			for (const change of (await gitStatus(params.workspaceId, scope)).changes)
				files.push({ path: change.path, scope });
		} else if (artifact.kind === "change" && artifact.path) {
			files.push({ path: artifact.path, scope: { kind: "uncommitted" } });
		}
	}
	const entries: string[] = [];
	let bytes = 0;
	for (const file of files) {
		const result = await gitDiffFile(params.workspaceId, file.path, file.scope);
		const entry = JSON.stringify({ ...file, ...result });
		bytes += Buffer.byteLength(entry);
		if (bytes > 512 * 1024)
			throw new Error("This review change set exceeds the 512 KiB review limit");
		entries.push(entry);
	}
	return `Actual change-set contents (original and modified file versions):\n${entries.join("\n")}`;
}

async function fileFinding(
	params: ReviewParams,
	reviewedSha: string,
	f: ReviewFixComment,
): Promise<ReviewComment> {
	const origin = { todoId: params.id, reviewedSha, sessionId: params.sessionId };
	if (f.path && f.startLine && !anchorProblem(params.workspaceId, f.path, f.startLine)) {
		return addComment({
			workspaceId: params.workspaceId,
			kind: "inline",
			author: "agent",
			body: f.body,
			origin,
			anchor: {
				path: f.path,
				side: "worktree",
				contentHash: "",
				selectors: [
					{ kind: "lineRange", startLine: f.startLine, endLine: f.endLine ?? f.startLine },
				],
			},
		});
	}
	return addComment({
		workspaceId: params.workspaceId,
		kind: "review",
		author: "agent",
		body: f.body,
		origin,
		anchor: null,
	});
}

async function fileFindings(
	params: ReviewParams,
	reviewedSha: string,
	raw: ReviewFixComment[],
	signal: AbortSignal,
): Promise<{ filed: ReviewFixComment[] }> {
	const filed: ReviewFixComment[] = [];
	try {
		for (const f of raw) {
			signal.throwIfAborted();
			const persisted = await fileFinding(params, reviewedSha, f);
			filed.push({ ...f, id: persisted.id });
			signal.throwIfAborted();
		}
	} catch (err) {
		for (const f of filed) await deleteComment(params.workspaceId, f.id).catch(() => {});
		throw err;
	}
	return { filed };
}

async function unfileFindings(
	params: ReviewParams,
	filed: ReviewFixComment[],
	sent: boolean,
): Promise<void> {
	if (sent) {
		rollbackSend(
			params.workspaceId,
			filed.map((f) => f.id),
			params.sessionId,
		);
	}
	for (const f of filed) await deleteComment(params.workspaceId, f.id).catch(() => {});
}

async function prepareWorkerFix(
	params: ReviewParams,
	note: string,
	reviewedSha: string,
	raw: ReviewFixComment[],
	record: (autoCycles: number) => { item: Todo },
	recordGuide: () => Promise<void>,
	signal: AbortSignal,
): Promise<RecordedVerdict> {
	let marked: string[] = [];
	let filed: ReviewFixComment[] = [];
	let recorded = false;
	let recordedReview: ReturnType<typeof todoReviewRecord>;
	const compensate = async (error: unknown): Promise<void> => {
		if (!recorded) throw error;
		await withReviewLock(params.workspaceId, async () => {
			if (!isDeepStrictEqual(todoReviewRecord(params), recordedReview)) return;
			if (marked.length > 0) rollbackSend(params.workspaceId, marked, params.sessionId);
			record(2);
		});
		notifyExtUi(
			params.sessionId,
			`Fix send failed: ${error instanceof Error ? error.message : String(error)} — the findings stay in Review for you.`,
			"error",
		);
	};
	try {
		const prepared = await withReviewLock(params.workspaceId, async () => {
			signal.throwIfAborted();
			const snapshot = await getReviewSnapshot(params.workspaceId);
			signal.throwIfAborted();
			filed = (await fileFindings(params, reviewedSha, raw, signal)).filed;
			let item: Todo;
			try {
				signal.throwIfAborted();
				item = record(1).item;
			} catch (err) {
				await unfileFindings(params, filed, false);
				throw err;
			}
			recorded = true;
			recordedReview = todoReviewRecord(params);
			await recordGuide();
			signal.throwIfAborted();
			const findings: ReviewComment[] = await itemFixFindings(params);
			signal.throwIfAborted();
			const sentIds = findings.map((c) => c.id);
			const fixPackage =
				findings.length > 0 ? await buildSendPackage(params.workspaceId, findings) : null;
			if (sentIds.length > 0) {
				signal.throwIfAborted();
				await markCommentsSent(params.workspaceId, sentIds, params.sessionId);
				marked = sentIds;
			}
			return {
				text: fixPackage
					? `${renderFixPackage(item, note)}\n\n${fixPackage}`
					: renderFixPackage(item, note),
				details: buildReviewFixDetails({
					itemId: item.id,
					itemTitle: item.title,
					reviewId: snapshot.review.id,
					note,
					comments: findings,
				}),
			};
		});
		return {
			kind: "changes",
			canAutoFix: true,
			findings: filed,
			deliverFix: async () => {
				try {
					signal.throwIfAborted();
					await sendReviewFixToSession(params.sessionId, prepared.text, prepared.details);
				} catch (error) {
					await compensate(error);
				} finally {
					releaseItemFix(params.sessionId, params.id);
				}
			},
		};
	} catch (error) {
		try {
			await compensate(error);
			return { kind: "changes", canAutoFix: false, findings: filed };
		} finally {
			releaseItemFix(params.sessionId, params.id);
		}
	}
}

async function recordVerdict(
	params: ReviewParams,
	result: PlanReviewResult,
	reviewedSha: string,
	deliverFix: boolean,
	signal: AbortSignal,
): Promise<RecordedVerdict> {
	const recordGuide = async (): Promise<void> => {
		try {
			signal.throwIfAborted();
			await setReviewGuide(params.workspaceId, {
				summary: result.summary ?? "",
				readingOrder: result.readingOrder ?? [],
				verdict: result.verdict,
				todoId: params.id,
				sessionId: params.sessionId,
				reviewedSha,
				at: Date.now(),
			});
		} catch (error) {
			log.warn(`review guide was not recorded for ${params.workspaceId}`, error);
		}
	};
	if (result.verdict === "approve") {
		return withReviewLock(params.workspaceId, async () => {
			signal.throwIfAborted();
			const open = await itemOpenFindings(params);
			signal.throwIfAborted();
			if (open.length === 0) {
				approveTodoReview(params, "agent");
				await recordGuide();
				return { kind: "approved" };
			}
			cancelTodoReview(params);
			if (deliverFix)
				notifyExtUi(
					params.sessionId,
					`The reviewer approved "${result.itemTitle}", but ${open.length} finding(s) on it are still open in Review — the step stays unreviewed until they are resolved.`,
					"warning",
				);
			return { kind: "approve-blocked", openFindings: open.length };
		});
	}
	const spent = todoReviewAutoCycles(params) ?? 0;
	const canAutoFix = getConfig().reviewAutoFix !== false && spent < 1;
	const note = result.summary || DEFAULT_FIX_NOTE;
	const record = (autoCycles: number) =>
		recordAgentChangesRequested({
			...params,
			...(result.summary ? { note: result.summary } : {}),
			autoCycles,
		});
	if (!canAutoFix) {
		const findings = await withReviewLock(params.workspaceId, async () => {
			const { filed } = await fileFindings(params, reviewedSha, result.findings, signal);
			try {
				signal.throwIfAborted();
				record(2);
			} catch (err) {
				await unfileFindings(params, filed, false);
				throw err;
			}
			await recordGuide();
			return filed;
		});
		return { kind: "changes", canAutoFix: false, findings };
	}
	if (!deliverFix) {
		const { filed: findings } = await withReviewLock(params.workspaceId, async () => {
			const filing = await fileFindings(params, reviewedSha, result.findings, signal);
			const { filed } = filing;
			try {
				signal.throwIfAborted();
				await markCommentsSent(
					params.workspaceId,
					filed.map((f) => f.id),
					params.sessionId,
				);
				signal.throwIfAborted();
				record(1);
			} catch (err) {
				await unfileFindings(params, filed, true);
				throw err;
			}
			await recordGuide();
			return filing;
		});
		return { kind: "changes", canAutoFix: true, findings };
	}
	if (claimItemFix(params.sessionId, params.id))
		return prepareWorkerFix(
			params,
			note,
			reviewedSha,
			result.findings,
			record,
			recordGuide,
			signal,
		);
	const findings = await withReviewLock(params.workspaceId, async () => {
		const { filed } = await fileFindings(params, reviewedSha, result.findings, signal);
		try {
			signal.throwIfAborted();
			record(2);
		} catch (err) {
			await unfileFindings(params, filed, false);
			throw err;
		}
		await recordGuide();
		return filed;
	});
	return { kind: "changes", canAutoFix: false, findings };
}

export type ReviewRunner = typeof runSessionChild;

async function runReview(
	params: ReviewParams,
	pkg: string,
	reviewedSha: string,
	itemTitle: string,
	signal: AbortSignal,
	runSubagent: ReviewRunner,
): Promise<PlanReviewResult> {
	const cfg = getConfig();
	const def = await resolveNewChatModel({});
	const model = cfg.reviewModel ?? def.model;
	const thinkingLevel = cfg.reviewEffort ?? def.thinkingLevel;
	if (!model) throw new Error("Configure a review model before starting a review");
	const effort = await clampThinkingForModel(model, thinkingLevel);
	const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
	const changeSet = await reviewChangeSet(params);
	reviewSignal.throwIfAborted();
	const run = await runSubagent(params.sessionId, {
		name: "Plan reviewer",
		instructions: REVIEWER_SYSTEM_PROMPT,
		prompt: `${pkg}\n\n${changeSet}\n\n${REVIEWER_OUTPUT_CONTRACT}`,
		model,
		thinkingLevel: effort,
		tools: REVIEWER_TOOLS,
		maxTurns: 20,
		signal: reviewSignal,
	});
	reviewSignal.throwIfAborted();
	if (run.status !== "completed") {
		throw new Error(`The review subagent did not complete (${run.status}).`);
	}
	const parsed = parseVerdict(run.text, params.id, itemTitle);
	if (!parsed) throw new Error("The review subagent did not return a valid verdict.");
	return { ...parsed, ...(reviewedSha ? { reviewedSha } : {}) };
}

async function handleRequestReview(
	sessionId: string,
	itemId: string,
	signal: AbortSignal,
	runSubagent: ReviewRunner,
): Promise<{ result: PlanReviewResult; text: string }> {
	signal?.throwIfAborted();
	const workspaceId = getSessionWorkspaceId(sessionId);
	if (!workspaceId) throw new Error("This chat is not attached to a workspace.");
	if (!claimItemReview(sessionId, itemId)) throw new Error("This step is already being reviewed.");
	const params = { workspaceId, sessionId, id: itemId };
	try {
		await settleChangeArtifacts(workspaceId);
		signal?.throwIfAborted();
		const { pkg, reviewedSha } = startTodoReview(params);
		return await onPlanChain(workspaceId, sessionId, async () => {
			signal?.throwIfAborted();
			const itemTitle = await itemTitleOf(workspaceId, sessionId, itemId);
			const result = await runReview(params, pkg, reviewedSha, itemTitle, signal, runSubagent);
			signal?.throwIfAborted();
			const outcome = await recordVerdict(params, result, reviewedSha, false, signal);
			const blocked =
				outcome.kind === "approve-blocked" ? { blockedByOpenFindings: outcome.openFindings } : {};
			const findings =
				outcome.kind === "changes" ? (outcome.findings ?? result.findings) : result.findings;
			return { result: { ...result, findings, ...blocked }, text: composeText(result, outcome) };
		});
	} catch (err) {
		cancelTodoReview(params);
		throw err;
	} finally {
		releaseItemReview(sessionId, itemId);
		await publishReview(workspaceId).catch(() => {});
	}
}

export function startPlanReview(
	workspaceId: string,
	sessionId: string,
	itemId: string,
	runSubagent: ReviewRunner = runSessionChild,
): boolean {
	if (getSessionWorkspaceId(sessionId) !== workspaceId)
		throw new Error("This review belongs to another workspace");
	if (!claimItemReview(sessionId, itemId)) return false;
	let scope: ReturnType<typeof acquireSessionReviewScope>;
	const params = { workspaceId, sessionId, id: itemId };
	let review: ReturnType<typeof startTodoReview>;
	try {
		scope = acquireSessionReviewScope(sessionId);
	} catch (error) {
		releaseItemReview(sessionId, itemId);
		throw error;
	}
	try {
		review = startTodoReview(params);
	} catch (error) {
		releaseItemReview(sessionId, itemId);
		scope.release();
		throw error;
	}
	const { pkg, reviewedSha } = review;
	void onPlanChain(workspaceId, sessionId, async () => {
		let itemTitle = itemId;
		try {
			scope.signal.throwIfAborted();
			itemTitle = await itemTitleOf(workspaceId, sessionId, itemId);
			scope.signal.throwIfAborted();
			const result = await runReview(
				params,
				pkg,
				reviewedSha,
				itemTitle,
				scope.signal,
				runSubagent,
			);
			scope.signal.throwIfAborted();
			return await recordVerdict(params, result, reviewedSha, true, scope.signal);
		} catch (error) {
			cancelTodoReview(params);
			reviewFailedPublisher({
				workspaceId,
				sessionId,
				itemId,
				itemTitle,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	})
		.finally(() => releaseItemReview(sessionId, itemId))
		.then(async (outcome) => {
			try {
				await publishReview(workspaceId);
			} catch {
				// Snapshot publication must not strand the reserved fix delivery.
			}
			await outcome.deliverFix?.();
		})
		.catch((error) => log.warn(`plan review failed (${itemId})`, error))
		.finally(async () => {
			try {
				await publishReview(workspaceId).catch(() => {});
			} finally {
				scope.release();
			}
		});
	recordWorkspaceActivity(workspaceId);
	return true;
}

export async function maybeAutoReReview(
	workspaceId: string,
	sessionId: string,
	runSubagent: ReviewRunner = runSessionChild,
): Promise<void> {
	try {
		const plan = await listTodos({ workspaceId, sessionId });
		const items = [...plan.todos, ...plan.groups.flatMap((g) => g.todos)];
		for (const item of items) {
			const r = item.review;
			if (r?.reviewing || item.status !== "done") continue;
			if (todoReviewAutoCycles({ workspaceId, sessionId, id: item.id }) !== 1) continue;
			const freshCommitDelta =
				r?.state === "changes_requested" && (r.unreviewedShas?.length ?? 0) > 0;
			if (!freshCommitDelta && r?.state !== "unreviewed") continue;
			startPlanReview(workspaceId, sessionId, item.id, runSubagent);
		}
	} catch (err) {
		log.warn(`auto re-review skipped (${workspaceId}/${sessionId})`, err);
	}
}

export function installRequestReviewSeam(runSubagent: ReviewRunner = runSessionChild): void {
	setResolveCommentHandler((sessionId, commentId, note, signal) => {
		const workspaceId = getSessionWorkspaceId(sessionId);
		if (!workspaceId) throw new Error("This chat is not attached to a workspace");
		return withReviewLock(workspaceId, async () => {
			signal?.throwIfAborted();
			const comment = resolveCommentFromAgent(sessionId, commentId, note);
			if (comment.origin)
				await clearChangesRequestedIfResolved({
					workspaceId,
					sessionId: comment.origin.sessionId,
					id: comment.origin.todoId,
				});
			return comment;
		});
	});
	setRequestReviewHandler((sessionId, itemId, signal) =>
		handleRequestReview(sessionId, itemId, signal, runSubagent),
	);
}

export async function reviewAllPlan(workspaceId: string, sessionId: string) {
	const plan = await listTodos({ workspaceId, sessionId });
	const items = [
		...plan.todos,
		...plan.groups.flatMap((group) => group.todos),
		...(plan.adoptedCommits ?? []),
	];
	const targets = items.filter(
		(item) =>
			item.review &&
			!(item.review.state === "reviewed" && (item.review.unreviewedShas?.length ?? 0) === 0) &&
			!item.review.reviewing,
	);
	const started = targets.filter((item) => startPlanReview(workspaceId, sessionId, item.id));
	return {
		ok: true as const,
		total: started.length,
		...(started.length === 0 && planReviewRunning(workspaceId, sessionId)
			? { alreadyRunning: true as const }
			: {}),
	};
}

export async function requestPlanFix(params: ReviewParams & { feedback: string }): Promise<void> {
	if (getSessionWorkspaceId(params.sessionId) !== params.workspaceId)
		throw new Error("This fix request belongs to another workspace");
	if (!claimItemFix(params.sessionId, params.id))
		throw new Error("A fix request is already active for this step");
	let scope: ReturnType<typeof acquireSessionReviewScope> | undefined;
	let marked: string[] = [];
	let rollback: (() => void) | undefined;
	try {
		scope = acquireSessionReviewScope(params.sessionId);
		const signal = scope.signal;
		const prepared = await withReviewLock(params.workspaceId, async () => {
			signal.throwIfAborted();
			const request = requestTodoFix(params);
			rollback = () => {
				rollbackTodoFix(params, request.previous, request.requested);
			};
			const reviewId = (await getReviewSnapshot(params.workspaceId)).review.id;
			signal.throwIfAborted();
			const findings = await itemFixFindings(params);
			signal.throwIfAborted();
			const text = findings.length
				? `${request.pkg}\n\n${await buildSendPackage(params.workspaceId, findings)}`
				: request.pkg;
			if (findings.length) {
				signal.throwIfAborted();
				marked = findings.map((finding) => finding.id);
				await markCommentsSent(params.workspaceId, marked, params.sessionId);
			}
			return {
				text,
				details: buildReviewFixDetails({
					itemId: params.id,
					itemTitle: request.itemTitle,
					reviewId,
					note: params.feedback.trim(),
					comments: findings,
				}),
			};
		});
		signal.throwIfAborted();
		recordWorkspaceActivity(params.workspaceId);
		await sendReviewFixToSession(params.sessionId, prepared.text, prepared.details);
	} catch (error) {
		await withReviewLock(params.workspaceId, async () => {
			if (marked.length) rollbackSend(params.workspaceId, marked, params.sessionId);
			rollback?.();
		});
		throw error;
	} finally {
		try {
			await publishReview(params.workspaceId).catch(() => {});
		} finally {
			releaseItemFix(params.sessionId, params.id);
			scope?.release();
		}
	}
}

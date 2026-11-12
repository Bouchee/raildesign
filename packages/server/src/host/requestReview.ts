import type { PlanReviewResult, ReviewFixComment, TodoPlan } from "@thinkrail/contracts";
import { isPlanReviewResult } from "@thinkrail/contracts";

import { listTodos } from "../todos";

/** Reads stored, grouped and adopted items through the application's current plan service. */
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
	// Construct explicitly, never spread the model object: `blockedByOpenFindings` is host-set only, so a
	// hallucinated value must not survive an approve. See planReview.SPEC.md.
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

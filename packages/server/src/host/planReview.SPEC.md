---
id: submodule-server-host-plan-review
type: submodule-design
status: active
title: plan review — independent SDK child and durable findings
parent: submodule-server-host
depends-on: [submodule-server-host, submodule-server-todos, submodule-server-agent]
references: [submodule-server-reviews]
tags: [host, review]
---

## Responsibility

Review one completed Plan step. Save the verdict, canonical Review findings and reading guide. Deliver a fix request when the configured budget permits it.

`requestReview.ts` owns this flow. `reviewerRole.ts` defines the review role and JSON contract. `planReviewQueue.ts` serializes reviews for each plan and prevents duplicate reviews of one step.

## Execution contract

- Run the reviewer with `agent.runSessionChild`. Use the same SDK execution, tool dispatch and cancellation path as other children. The parent session owns the child. Do not create another visible chat or a separate provider client.
- Resolve the model from `reviewModel`, then the host's new-chat model default. Resolve effort from `reviewEffort`, then the host's new-chat effort default. Clamp effort for the selected model and pass it explicitly. A missing model fails the review.
- Permit only `read`, `search`, `spec_search`, `spec_grep`, `spec_get`, `spec_graph` and `spec_validate`. The manager enforces this list. The reviewer cannot edit files, execute commands, delegate work or request another review.
- Supply the step's title, note, artifacts and verification claims. Also supply the actual original and modified file versions from `gitStatus` and `gitDiffFile`. Resolve commit artifacts in commit scope and change artifacts in uncommitted scope. Reject a change set above 512 KiB. Do not silently truncate it.
- Limit the child to 20 model turns and five minutes. A failed, interrupted, cancelled or timed-out child cannot approve a step.
- Treat model output as untrusted. `parseVerdict` uses `isPlanReviewResult`, stamps the host-owned item ID and title, normalizes path separators, and copies only accepted fields. Require a known verdict, nonempty finding IDs and bodies, valid line ranges and bounded reading order. A request for changes requires at least one finding. Invalid output fails the review.

## Entry points and ownership

- `installRequestReviewSeam()` installs `request_review` and `resolve_comment` handlers in the agent module. The tool path waits for `settleChangeArtifacts` before it snapshots a completed step.
- `startPlanReview(workspaceId, sessionId, itemId)` starts a detached button review. Validate the session's workspace before creating the synchronous pending mark. Record workspace activity when the review is accepted.
- `reviewAllPlan` uses the same entry point for each eligible step. `maybeAutoReReview` uses it after a fresh fix delta at auto-cycle 1.
- The `agentReviewEnabled` setting gates only the agent's `request_review` tool. Button review remains available.
- Both tool and button paths share one promise chain per workspace and parent session. A separate item claim rejects duplicate requests for the same step. The chain covers reviewer execution and verdict/file writes; release the item claim in `finally` before waiting for a worker fix run, including failures before child creation. A failed review clears its pending mark. It leaves no successful verdict record.
- A button review captures a manager-owned review scope before enqueue. Stop, close and delete cancel that scope and await its release. Check its signal before queued child admission, after awaited reads and before filing effects. Keep the scope through any worker fix run; release it after pending state and item claims are cleared and delivery settles.
- A detached failure publishes `ReviewFailedPayload` through `review.failed`, including the owning session, step and reason. An awaited tool failure returns through the tool result. Publish the current Review snapshot when either path settles.

## Findings and verdict records

- File findings through the existing Review service. Stamp each finding with the parent session, Plan step and reviewed SHA. Use an inline anchor only when it is valid; otherwise retain the finding as a review-level comment.
- Expose the persisted `rc_*` IDs to the worker. The model's temporary IDs do not identify stored comments.
- Hold `withReviewLock` while filing, marking findings sent, updating the step's review record and recording its guide. A concurrent Clear cannot split these operations. Child execution and worker execution run outside the lock.
- Filing is all-or-nothing. If a later write fails, delete drafts already filed. If a record write fails after marking findings sent, roll them back before deleting them.
- Save summary and reading order only after accepting the verdict. An accepted verdict replaces the old guide, including empty fields. Guide persistence is best-effort. Invalid output, failed filing and an approval blocked by open findings preserve the old guide.
- An approval settles the step only when no open finding remains for that step. Otherwise clear pending, retain the prior review record and tell the worker to resolve the findings it fixed. Only the host can add `blockedByOpenFindings` to a result.
- `resolve_comment` resolves a sent comment assigned to the invoking worker by canonical ID. Use the existing Review service and clear changes-requested state only when its findings are resolved.

## Fix budget and delivery

- Both entry points use `reviewAutoFix` and the persisted auto-cycle count. Permit one automatic fix cycle. The tool result states whether the worker must fix now or report the findings and wait for the user. Tool guidance must follow that result.
- At cycle 1, the tool path files and marks canonical findings sent before returning them to the worker. The button path files findings, records the cycle and reserves its outgoing findings under one Review lock, then releases its review chain and item review claim before calling `sendReviewFixToSession` outside the lock. The worker may request re-review before its own run ends.
- Keep the per-item fix claim until the queued SDK fix run settles. A stopped, closing or deleted session must reject delivery. The sender must not report a successful enqueue when no run was admitted.
- On preparation or delivery failure after recording a request for changes, roll assigned findings back to draft and record terminal cycle 2 only while the stored review still equals that request. A later review result must survive an earlier fix run failing or stopping. Findings remain available in Review. Release the fix claim in `finally`.
- `requestPlanFix` uses the same stored findings, canonical package and delivery primitive for the explicit Fix button. On failure, restore the previous Todo record only if it still belongs to that request.
- Automatic re-review requires a completed step, cycle 1 and a new unreviewed commit delta. It must not spin on the same change set.

## Module boundary

Use the public barrels for `agent`, `todos`, `reviews`, `git`, `settings` and `workspaces`. Do not access SDK private fields or duplicate their stores. `todoReview` can read claim state from `planReviewQueue`; it must not import `requestReview`.

Public flow functions are `startPlanReview`, `reviewAllPlan`, `requestPlanFix`, `maybeAutoReReview`, `installRequestReviewSeam` and `setReviewFailedPublisher`. `parseVerdict`, `composeText` and `itemTitleOf` are pure or injected lookup helpers.

## Verification

`planReview.test.ts` uses actual SDK child dispatch with `ScriptedModel` and a temporary local Git repository. It checks actual file reads and before/after snapshots, canonical findings and guide persistence, invalid-output retry cleanup, request-review → resolve-comment → approval, Stop cancellation, and automatic fix → resolve → completion → re-review within the worker run. A later worker failure cannot replace the approved result. The real host fixture also invokes `set_title` through the SDK and checks persisted titles and manual-name protection. `requestReview.test.ts` checks strict parsing and policy-dependent result text. `titleTool.test.ts` checks that a revoked grant blocks delayed title effects. No test requires a real API key or external provider.

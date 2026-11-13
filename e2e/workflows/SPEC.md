---
id: module-workflow-tests
type: module-design
status: active
title: e2e/workflows — SDK workflow acceptance and deterministic helpers
parent: architecture
references: [submodule-server-agent, module-server]
tags: [testing, workflow-system]
---

## Scope / trigger

The routing live scenarios use the isolated browser host and its current SDK sessions. Deterministic
helpers check tool/skill discipline, files, YAML spec metadata, budgets and structured replies. The old
pi headless scenario runner, credential-copying environment and JSONL transcript presets are retired.

## Signatures

Specs import through `harness/index.ts`. It exposes `EventLog`, captured tool events, signal watchers,
checks, budget helpers, reply parsers, artifact presets, Markdown masking and throwaway workspace
helpers, plus `openSeededSession` and `driveTurn` through the existing host wire. The installed SDK owns
the model loop; helpers only seed, observe and answer host interactions. Optional one-shot model
diagnostics never run in routing acceptance or the unit suite.

## Contracts

`EventLog` consumes application `SessionEvent` records, or reconstructs tool starts/ends and assistant
text from a `session.getMessages` snapshot in message order. It never installs an in-process server
publisher to observe the browser host. A completed user turn is `agent_settled`.
Tool starts/ends share their call ID. Deterministic checks decide pass/fail; model-based suggestions,
user simulation and rubric diagnostics never establish a passing result. Masked fixture Markdown
cannot enter repository spec discovery. Artifact copying excludes `.git`, keeping `.gitignore` and
`.github`.

`driveTurn` uses the real prompt, question-response, approval and abort routes, with existing deterministic
budgets. The prompt RPC may delay its acknowledgement for the host's send window; dispatch it with the
turn budget as its explicit timeout and observe/respond concurrently. Attach its rejection handler at
dispatch, fail promptly on rejection, and await the request after abort before returning. An unchanged
idle snapshot from before admission is not completion of the new turn. After forbid/error/budget
checks, a satisfied stop signal aborts before answering any further question or approval. Otherwise,
denied confirmations fail and abort immediately. Stop signals succeed only when no prohibition was
observed, including the final snapshot recheck. It waits for idle settlement before returning the
final snapshot, log and failure. Unexpected/failed settlement and missing stop signals fail. Questions
default to a declined answer; an edit confirmation requires the scenario's explicit allow predicate.

`allowConfirm` returns `true`/`false` for an immediate per-call decision. Only an explicit `undefined`
from a supplied callback defers to an external reviewer: keep the host's SDK interruption paused,
do not mark it answered or send a reply, and continue observing forbid/stop/budget conditions. A missing
callback or missing tool call still denies. External decisions use the existing anchored
`session.extUiReply`; helpers never deserialize or approve SDK state themselves.

`openSeededSession` uses `project.open`'s host-resolved `project.path` as its cwd and compares the default
workspace against that path. A fixture's temporary-folder spelling can differ through symlinks.

## Validation and errors

Malformed structured replies return the existing rejected/unclear result. Missing stop signals or
budget violations cannot be recorded as success. No helper copies another agent's credentials, opens
pi sessions or restores an old session factory. File/worktree fixtures remain disposable and isolated.

## Good / base / bad cases

Pure unit cases can compare skill-read order and reject an invalid questionnaire option without a
provider. A missing/invalid model reply is not evidence that a workflow passed. A historical pi JSONL
fixture cannot seed a RailDesign session.

## Tests required

`harness.browser.spec.ts` opens a real seeded SDK session without prompting a model, and checks the
host-resolved cwd, default workspace identity and empty transcript before live acceptance.

`harness.unit.spec.ts` retains snapshot/query, signal ordering, pure questionnaire choices/parsing,
watchdog budgets, judge/user-simulation parsing, snapshot masking and file/spec checks. It does not
exercise a model, advanced tool registration or session recovery. It also checks the wire driver's
forbid/stop precedence, denial/abort, question anchors, final snapshot and missing-stop failure.

`routing.live.spec.ts` migrates all ten original routing business scenarios to the current SDK host:
feature/bug/PR/setup routes, direct questions/renames, empty/code-only dispatch and declined spec-graph
extension. Actual successful Skill reads/order, forbidden calls and git status decide the result.
R10 answers any offered questionnaire with an explicit native custom refusal for every actual
question and checks that the same refusal was recorded before accepting the no-further-effects result.
Skipping a questionnaire means declining an interview, not refusing the work. A plain settled offer
without a questionnaire remains valid. Offer keywords must appear in the same visible assistant
message, with no arbitrary character-distance limit.
Only the exact requested rename path may receive edit approval. Each case attaches its final snapshot,
workspace status/diff and product source identity. Run it with the public `e2e:agent` runner; helper
unit tests remain excluded from browser discovery.

Routing live acceptance requires an active per-call reviewer for bash confirmations. The reviewer
inspects the actual command and test-session ownership through the current host wire and decides
through its native approval route. There is no command classifier, allowlist or sticky tool approval.
After rejecting a call, the reviewer also aborts and retains a failed review decision; SDK rejection
alone permits continuation and can never establish a passing acceptance result.
Unanswered confirmations hit the existing budget and fail; these scenarios are not unattended checks.
The helper unit suite simulates external decisions deterministically without a model or reviewer.

## Wrong / correct

Use isolated browser/SDK scenarios for production acceptance. Questions use the current
`session.respondToTool` route with host-provided run/interaction/revision anchors. Do not resurrect
the old question mailbox, `SessionManager`, pi-auth copying or a fake-success runtime adapter.
The current Stage 3 live scenario checks manual Skill invocation, workspace instructions,
`skill_read`, Todo/Spec effects and refresh durability; separate live specs cover Skill reload and
Plan behavior. These checks do not replace complete workflow routing, codebase importing or
multi-round clarification followed by implementation and restored-conversation recall.

The original Pi implementations remain in Git history. Routing has current SDK cases; importing and
multi-round clarification/restored-conversation recall still need equivalent SDK acceptance. Retained
Markdown workspace fixtures may support those scenarios. No helper reads an old Pi session transcript.

---
id: submodule-server-agent
type: submodule-design
status: active
title: agent — SDK execution and application sessions
parent: module-server
depends-on: [module-contracts]
tags: [agents-sdk]
---

## DeepSeek web tools

`webAccess` owns the separate protected platform key and bounded DeepSeek Search/Fetch requests.
The SDK extension receives grant-bound service callbacks. Stop aborts requests and prevents late results.
The host captures structured content and details by tool-call ID for transcript cards while the model
receives readable text through the public FunctionTool interface. No key enters browser state.

## Responsibility

Own RailDesign sessions, application transcript projection and one active OpenAI Agents SDK Runner per session. The SDK owns the model loop and tool dispatch. The host owns identity, workspace grants, durable records, interaction ownership and completion. There is one execution path for every launcher.

## Boundary

The public `index.ts` exposes session create/read/prompt/abort/delete, session publishers, model configuration, one-shot SDK calls and the retained MCP/Skills configuration services. Sibling modules use this barrel only. SDK objects, credentials and checkpoints never enter browser contracts. Sessions use fresh application JSON records under `<dataDir>/sessions`; old pi records, settings, providers and extensions are not read or imported.

Each `session.event` envelope carries session ID, run ID and monotonically increasing sequence. Transcript messages have stable IDs. Final output corrects the corresponding streamed message. Snapshot reads return their event watermark. Execution indicators begin only when an executor starts, after approval. Settlement waits for model/tool cleanup; a cancelled or pending-approval stream is never successful.

Tool failure status comes from invalid call JSON, SDK error callbacks, command exit results and explicit approval rejection, never from text returned by repository files or tools. The run's per-call metadata carries this status into both live and saved tool results.

Each run creates a new AbortController and workspace-bound tools. Stop revokes the grant before aborting the model and subprocess group. Tools revalidate grant and an existing workspace record before effects. Read/search/edit paths use the filesystem resolver, including real paths, symlinks, new-file ancestors and `.git` checks. Commands reuse `runBounded` in the assigned worktree with time/output bounds. The tools capture configured model-key environment references at run creation and exclude those names, plus common secret names, from child environments. Edits check original text, apply the SDK diff and replace atomically. This is host-account execution, not an operating-system sandbox.

Approvals use SDK `needsApproval` and application dialog cards. Questions use the same resumable SDK
interruption boundary with the retained portable questionnaire schema/result formatter and question
renderer. Only the question is resumed after its owned answer; a composer steering input can supersede
that question with the existing deferred/chat acknowledgement. It cannot approve another tool.
Responses bind session, run, tool call, interaction and revision. Identical decisions return their durable
receipt; stale, missing-call, conflicting and cross-session replies fail before execution.

Session get/add/pop/clear and public history transactions persist append/suffix replacement together
with operation receipts. Canonical input content, current history membership and summary retirements are
separate. Pop permits re-addition; memory reset clears retirements but keeps transcript and receipts.
Queue admission commits its model item, transcript user message and queue removal in one record.
Queues expose pending/staged input; model-history commit establishes admission. Steering uses public
`RunState.addInput` at an eligible model boundary, stays durable on rejection, and never bypasses an
interaction. Unused steering runs before follow-ups only after normal settlement. Stop preserves queued
input, revokes the grant first, then waits for model and process cleanup.

Trusted checkpoints retain logical run identity, the original extension registrations and declared settings and the
original worktree grant. Close/shutdown saves pending interactions. Attachment builds new tools/controllers
before `RunState.fromString`, and waits for response readiness before returning its snapshot. Approved
completed tools do not replay. Record executor start before effects and its result after completion.
Restart classifies an unrecorded result as unknown, shows it in the transcript, repairs paired model-history
call/results and requires explicit new input. Model requests without resumable interactions become interrupted.
The registry supplies fresh SDK factories and generic argument/response policies; schema and result formatting stay in the extension server half. The complete Stage 3 graph integrations remain owned by that stage; its preserved services stay in place.

Summary generation receives a detached older prefix only after full settlement without a checkpoint or
pending interaction. Retain the whole newest exchange and paired ordinary FunctionTool records. A paired
result that Stop or a run error closed as `incomplete` (the SDK 0.21.0 abort marker, as in its internal
`buildFunctionAbortResult`) can be summarized; only an `in_progress` result blocks. The Go
model's published context budget minus output/system headroom sets the automatic threshold at 75%; UTF-8
serialized bytes provide a conservative internal token upper bound. User-visible counts use actual SDK
request usage, never that byte estimate. A nonempty bounded summary must reduce model history. Commit model
memory, retired IDs, the summary marker and operation receipt against the unchanged revision. Generation,
cancellation, validation and write failures preserve committed history. Replay never regenerates or restores
an old window. New input cancels the summary and waits for cleanup before its Runner starts.

## Model configuration

Only the configured, verified stage-1 Responses target is offered. API keys are host-side and saved with mode 0600 in the RailDesign data directory. SDK tracing starts disabled. When enabled, an application-local processor records only trace/span IDs, fixed workflow names, span types and timestamps through the local logger. It replaces the SDK exporter; no trace reaches OpenAI, and sensitive model/tool content is excluded. Ordinary FunctionTools are used for files and commands; native provider shell/patch/compact endpoints are not required.

Go requests identify the client as `RailDesign/0.1`. `createConfiguredModel(model, sessionId)` requires the application conversation ID and sends it as `x-opencode-session` through the public OpenAI client's `defaultHeaders`. Every run and approval continuation in that conversation uses the stored session ID, independent of run IDs and credentials. One-shot assistance allocates one UUID for its logical invocation. The fixed `responsesClientSettings` uses public `ModelSettings.providerData.extra_headers` for the user agent because Agents SDK 0.21.0 replaces the client default with its own per-request header. Model discovery sends the same client identity without inventing a conversation. This follows the [Go client requirements](https://opencode.ai/docs/console/go/#where-can-i-use-it), checked 2026-11-11 with Agents SDK 0.21.0 and OpenAI 7.55.0; generic SDK identification or a missing session header can reject a request before inference.

## Scenario: the first SDK workflow

### Scope / Trigger

Stage 1 replaces the execution kernel while preserving the existing workbench and workspace services.

### Signatures

`createSession({cwd,workspaceId,model?,thinkingLevel?})` returns the application session identity.
`promptSession(sessionId,text,images?,messageId?)` admits one input synchronously and returns full settlement.
`abortSession(sessionId)` waits for cancellation cleanup. `getSessionMessages(sessionId,workspaceId,cwd)`
returns `{summary,messages,eventSeq}`. `resolveExtUi(response)` applies an owned decision.

### Contracts

`session.event` is `{sessionId,runId,seq,event}`; `seq` increases within a session. Snapshots carry the
matching watermark. Approval replies contain `{id,sessionId,runId,toolCallId,revision,value}`. SDK history and
transcript are separate fields in the atomic version-2 session record. The verified stage-1 target is
OpenCode Go `/inference/go/openai/v1` with `deepseek-v4.1-flash`: text and ordinary tools, reasoning off,
a published context budget of 1,000,000 tokens and unavailable price. The [provider model catalog](https://models.opencode.ai/providers/opencode-go/) identifies that context window for the selected Go model (checked 2026-11-12); near-limit service acceptance is not claimed. `maxTokens` is a request budget, capped at 8192.

### Validation & Error Matrix

| Condition | Result |
| --- | --- |
| A session already has an active run | Reject the new prompt before another Runner starts. |
| Missing workspace, escaped path, symlink escape or `.git` target | Reject before filesystem effects. |
| Patch original differs from current bytes | Preserve the target and require a fresh read. |
| Cross-session, stale or conflicting approval | Reject; identical decisions cannot execute twice. |
| Stop | Revoke the grant, cancel owned work, then settle cancelled. |
| Failed atomic write | Preserve the prior committed record and revision. |
| Unreadable or older-format session record | Skip it in session lists with a warning; other sessions and host startup continue. Direct attachment of that record still fails. |

### Good / Base / Bad Cases

Base: read a worktree file without approval. Good: approve one patch and command, save their actual
results and correct the streamed final message. Bad: a late approval after Stop must create no effect.

### Tests Required

Agent tests assert real file/process effects, approval ownership, Stop, atomic storage and fixed model
metadata. Store/transport tests assert canonical IDs, final correction, watermark buffering, isolation
and approval hydration. The live stage-1 browser scenario asserts actual bytes, command output, peer
worktree preservation and the displayed Diff.

### Wrong vs Correct

Wrong: infer tool failure from text containing `"isError":true`, or success from a resolved stream promise.
Correct: project explicit per-call executor status and settle only after checking errors, cancellation
and pending approval.


## Scenario: durable sessions and model summaries

### Scope / Trigger

Stage 2 keeps inputs and decisions consistent across model boundaries, disconnects and host restarts.
The Boundary rules above apply to both live and restored execution.

### Signatures

`steerSession(sessionId,text,images?,messageId?)` and `followUpSession(...)` persist queued input.
`updateQueuedMessage(sessionId,messageId,text,images?)` edits pending input; `removeQueuedMessage(sessionId,messageId)`
withdraws it. `compactSession(sessionId,{operationId?,instructions?,force?})` uses the configured ordinary SDK model.
`respondToTool(sessionId,toolCallId,response,{runId,interactionId,revision})` applies one owned response.

### Contracts

Fresh records use `version: 2`; earlier formats are rejected and left unchanged. A single atomic record
contains history, transcript, queue, checkpoints and receipts. Public queue entries are
`{id,text,state:"pending"|"staged",error?}`; admitted input appears once in the transcript. Regular queue
snapshots omit image bytes; SDK checkpoints stay on the host. Successful summary receipts retain SDK usage so
replay and reopening count it once. The `sdkTracingEnabled` app setting defaults to false and selects
only the local metadata processor.

### Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Input ID reused with different content | Reject before admission; distinct IDs may carry identical text. |
| Queued handover fails | Keep the input and visible error; allow pending input to be edited and retried. |
| Missing, wrong or expired interaction anchor | Reject; a valid identical response returns the saved result. |
| Reply arrives before restart hydration | Restore the owned record before checking the decision receipt. |
| Executor started without a saved result | Mark unknown, pair the model history and require explicit new input. |
| Summary generation fails, is cancelled, or has a stale revision | Preserve prior memory and receipts. |
| Summary operation already succeeded | Return its receipt without a model call or later-history overwrite. |

### Good / Base / Bad Cases

Base: refresh restores the same transcript, pending interaction and queue. Good: approve after restart,
execute once, then retry the same reply after another restart. Bad: neither a late reply after Stop nor
an unknown interrupted effect can start another side effect automatically.

### Tests Required

Store/summary tests compare durable bytes on failures and exercise pop, reset, retirements and receipt
replay. Manager/recovery tests force input, Stop and hydration interleavings and assert real effect
counts, ordered event sequences, fresh controllers and frozen extension settings. Focused browser
tests use real Go calls for queues, question answers, SIGKILL recovery and summary fact recall; offline
browser tests retain renderer coverage. Tracing tests enable a non-noop SDK trace and assert zero HTTP.

### Wrong vs Correct

Wrong: acknowledge staging as admission, or clear memory before saving its summary.
Correct: commit the history item and queue removal together; commit summary memory, marker, retired
IDs, usage and receipt together after checking the unchanged revision.

## Preserved Skills and delegation policies

The SDK replacement keeps the application Skill catalog, source discovery, two distinct project trust
and resource-trust gates, per-skill/group/workspace decisions, search ranking and bounded prompt
listing. Skill metadata/content uses application-owned types and the existing YAML parser; it does not
load a pi runtime, pi credentials, plugins or session files. Personal application Skills live under
`<dataDir>/skills`, project resources under `.raildesign`, and external-agent content roots retain their
existing enable/acknowledgement policy. Skill paths are checked against their declared canonical roots.
CLI and desktop stage the build-support Skill assets and call `setBundledSkillPaths(skillsDir)` before
host startup. This selects physical `host` and registry-extension content roots without installing
extension factories; disabled extensions still withhold their Skill assets. Source runs use the
existing package content roots.

`skillTools` loads applicable ancestor `AGENTS.md` files in parent-to-child order.
The prompt also requires applicable nested instructions before a directory change.
Instruction files have a combined 128 KiB limit.
Symbolic links cannot supply workspace instructions.

`skill_search` uses the current admitted catalog.
`skill_read` reads a selected Skill body or a resource in that Skill directory.
Each call checks current trust, enable policy and the run grant.
This separate read boundary permits approved Skill directories outside the worktree.
Ordinary workspace reads retain their existing boundary.
The host expands `/skill:name` from actual admitted content.
Manual-only Skills require an explicit user command before model access.

Child execution uses SDK `Agent.asTool()` for foreground delegation and the same session owner for
background tasks. Separate durable child records retain definition, parent, tool-call identity,
approval checkpoint, completion-delivery state and transcript. Current enable policy, project trust
and concurrency limits apply on admission and execution. Definition tool and Skill allowlists narrow
the actual SDK graph; children have no MCP or nested delegation tools. Standalone-chat children have
no Spec tools. Foreground initialization, restoration and invocation failures release the child slot.
Only the manager's real SDK records supply child ownership; obsolete fake delegation-service adapters
are removed.

Image dimensions, MIME detection and payload/request budgets remain in the pure `imageGuard` module.
Its retained tests validate those rules; the current verified text-only model does not enable vision.


## Preserved MCP management

Configuration validation, fingerprints, CRUD, per-project approval/overrides, logs/redaction and status
projection remain independent of the runner. HTTP uses the pinned SDK's public `MCPServerStreamableHttp`; stdio implements public `MCPServer`
with an owned process transport and the official MCP client's public framing so redacted stderr remains available. Management creates an owned transport, never
another model or a Pi session. The official MCP client handles discovery/DCR/PKCE with an owned token
store; callbacks and pasted replies bind to flow state and client ownership. Token files use 0600
under the application data root. Model credentials are not inherited by stdio processes; explicit MCP
authorization providers resolve only against current application model configuration.

Probe cancellation waits for its callback listener, connection and sign-in lock to close. Session
teardown invokes host-injected `setSessionResourceCleanup` before detachment; failure leaves the
session attached for retry. This avoids a dependency cycle with MCP connection state. Reconciliation
uses current project trust and exact entry fingerprints, and generations reject stale status results.
Local stdio and HTTP OAuth fixtures validate transport behavior without a live model or external login.

The SDK graph composes current admitted MCP FunctionTools and deferred `tool_search` results. Consent
uses owned SDK interruptions with once, chat and project choices. Saved decisions retain the complete
configuration fingerprint; recovery rechecks it before resuming. Stop closes owned connections and
process trees, while idle reload reconciles them before rebuilding tools. Search failures mark the call
failed even when SDK validation hides callback details. Remote error text is redacted and UTF-8 bounded.
MCP execution and consent regressions run through the actual SDK session manager.


Resource aggregation accepts explicit current snapshots and a validated application scope. It preserves
all live records, limits the visible finished window, merges the application's resource archive without
letting derived interruption replace an owner's settled outcome, and excludes foreign parent records.
The caller must establish live workspace/session authority before selecting the scope; these helpers
validate id syntax and record ownership, and grant no live resource authority. Command archival records real final output separately
from public summaries; only teardown's own cuts are marked interrupted. Child lifecycle archival
requires both workspace and parent ownership. `resourceIdentity` validates bounded plain application
ids before these helpers build or access archive paths.

Skill retained-tail analysis is separate from compaction execution. `compactedSkills` consumes the
owned transcript and an explicit committed cut supplied by the compaction transaction. Complete
retained loads suppress carryover; partial, truncated or gapped reads do not. It reads no runtime
journal or `firstKeptEntryId`. The visible compaction summary alone cannot establish the retained cut.
The fresh E2E evidence fixture reads only owned transcript objects; it contains no file-discovery or
`/compact` driver. Repeated compaction and real-model Skill compliance remain separate acceptance work.


The retained title service uses `renameSession(...,{onlyIfUnnamed:true}):Promise<boolean>` for an
atomic conditional title write. The check and write share the attached session entry; an automatic
proposal cannot replace a manual title or a previously accepted automatic title. The normal manual
rename operation remains unconditional. Tool registration for automatic title/workspace actions
belongs to the later advanced-tool gate.

## SDK Plan tools

The manager composes seven `@thinkrail/todos` FunctionTools with the session identity and current run grant.
`TODO_RULE` describes Plan creation and maintenance. Structured tool details remain in the application
transcript; the model receives bounded text. The existing TodoStore owns all Plan mutation.

## SDK Spec tools

Repository sessions compose eight `@thinkrail/spec-graph` FunctionTools and SPEC_RULE. Standalone
chats receive neither. Create, update and delete use SDK approval interruptions before filesystem effects;
all tools recheck the run grant and preserve the core's path and frontmatter validation.

## SDK background work and resources

`backgroundCommands` owns bounded noninteractive process execution through the subprocess module.
The manager retains output in resource history, publishes lifecycle changes and delivers each completion
once at a safe boundary. Normal parent completion leaves background work running. Parent Stop revokes
owned run grants, cancels child admissions, recursively disposes child-owned commands and waits for
cleanup, including commands retained by already completed children. Single-child and stop-all controls
use the same cleanup; a completed child keeps its settled status. The child completion gate stays closed
through process settlement, preventing a cleanup-generated result from starting another run.

Resource routes validate workspace and owning parent identities before reading output, child transcripts
or applying controls. Historical text and archived records grant no process authority. `ChatView` uses
these routes for the existing resource dock/inspector. Child sessions stay out of the ordinary chat list;
foreground SDK usage and background child usage are each counted once. Reload refuses active owned work.
SDK tests exercise approval restart, once-only completion, grant revocation during admission, actual
child tool graphs and OS process termination. Browser and live gates validate the composed controls.

The parent resource view includes commands owned by its direct children in the same workspace.
Command summaries retain their actual owner session ID. The manager derives this authorized owner set
once for resource queries, output/history reads and Stop routing; unrelated child archives are excluded.
Child command completion is delivered once to the parent's safe boundary and never restarts a completed
child. Historical output lookup uses the complete owned history, independent of the visible 20-row window.
Cleanup waits for all outcomes before reopening completion gates, including failed cleanup attempts.

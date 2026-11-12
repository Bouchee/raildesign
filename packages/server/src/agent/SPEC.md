---
id: submodule-server-agent
type: submodule-design
status: active
title: agent — SDK execution and application sessions
parent: module-server
depends-on: [module-contracts]
tags: [agents-sdk]
---

## Responsibility

Own RailDesign sessions, application transcript projection and one active OpenAI Agents SDK Runner per session. The SDK owns the model loop and tool dispatch. The host owns identity, workspace grants, durable records, interaction ownership and completion. There is one execution path for every launcher.

## Boundary

The public `index.ts` exposes session create/read/prompt/abort/delete, session publishers, model configuration, one-shot SDK calls and the retained MCP/Skills configuration services. Sibling modules use this barrel only. SDK objects, credentials and checkpoints never enter browser contracts. Sessions use fresh application JSON records under `<dataDir>/sessions`; old pi records, settings, providers and extensions are not read or imported.

Each `session.event` envelope carries session ID, run ID and monotonically increasing sequence. Transcript messages have stable IDs. Final output corrects the corresponding streamed message. Snapshot reads return their event watermark. Execution indicators begin only when an executor starts, after approval. Settlement waits for model/tool cleanup; a cancelled or pending-approval stream is never successful.

Tool failure status comes from invalid call JSON, SDK error callbacks, command exit results and explicit approval rejection, never from text returned by repository files or tools. The run's per-call metadata carries this status into both live and saved tool results.

Each run creates a new AbortController and workspace-bound tools. Stop revokes the grant before aborting the model and subprocess group. Tools revalidate grant and an existing workspace record before effects. Read/search/edit paths use the filesystem resolver, including real paths, symlinks, new-file ancestors and `.git` checks. Commands reuse `runBounded` in the assigned worktree with time/output bounds. The tools capture configured model-key environment references at run creation and exclude those names, plus common secret names, from child environments. Edits check original text, apply the SDK diff and replace atomically. This is host-account execution, not an operating-system sandbox.

Basic approvals use SDK `needsApproval` and application dialog cards. The checkpoint and card are saved before publication. Responses identify session, run, interaction and revision; duplicates cannot repeat effects, conflicting or stale responses fail. Stage 1 does not automatically recover an interrupted side effect after restart.

Initial Session storage implements public SDK get/add/pop/clear operations with serialized atomic writes. Completed transcripts remain readable. Stage 2 owns full durable queue/recovery/summary transactions; stage 3 owns model-visible MCP/Skills tool integration, Plan and child/background execution. MCP configuration/trust/OAuth and Skills discovery/enable policies remain implemented during stage 1. Unavailable operations must fail explicitly and their controls remain disabled.

## Model configuration

Only the configured, verified stage-1 Responses target is offered. API keys are host-side and saved with mode 0600 in the RailDesign data directory. SDK tracing starts disabled. Ordinary FunctionTools are used for files and commands; native provider shell/patch/compact endpoints are not required.

Go requests carry an owned User-Agent and a stable `x-opencode-session` for the application conversation.
`createConfiguredModel(model,sessionId)` requires that identity. Both session and one-shot callers apply
the fixed public Responses provider settings: SDK 0.21 overrides the client's default User-Agent, so
the owned agent label is supplied through `providerData.extra_headers`. The regression inspects final
outbound requests, including separate runs and one-shot identities, rather than constructor options.

Go requests identify the client as `RailDesign/0.1`. `createConfiguredModel(model, sessionId)` requires the application conversation ID and sends it as `x-opencode-session` through the public OpenAI client's `defaultHeaders`. Every run and approval continuation in that conversation uses the stored session ID, independent of run IDs and credentials. One-shot assistance allocates one UUID for its logical invocation. The fixed `responsesClientSettings` uses public `ModelSettings.providerData.extra_headers` for the user agent because Agents SDK 0.21.0 replaces the client default with its own per-request header. Model discovery sends the same client identity without inventing a conversation. This follows the [Go client requirements](https://opencode.ai/docs/console/go/#where-can-i-use-it), checked 2026-11-11 with Agents SDK 0.21.0 and OpenAI 7.55.0; generic SDK identification or a missing session header can reject a request before inference.

## Scenario: the first SDK workflow

### Scope / Trigger

Stage 1 replaces the execution kernel while preserving the existing workbench and workspace services.

### Signatures

`createSession({cwd,workspaceId,model?,thinkingLevel?})` returns the application session identity.
`promptSession(sessionId,text,images?)` admits one input synchronously and returns full settlement.
`abortSession(sessionId)` waits for cancellation cleanup. `getSessionMessages(sessionId,workspaceId,cwd)`
returns `{summary,messages,eventSeq}`. `resolveExtUi(response)` applies an owned decision.

### Contracts

`session.event` is `{sessionId,runId,seq,event}`; `seq` increases within a session. Snapshots carry the
matching watermark. Approval replies contain `{id,sessionId,runId,revision,value}`. SDK history and
transcript are separate fields in the atomic version-1 session record. The verified stage-1 target is
OpenCode Go `/inference/go/openai/v1` with `deepseek-v4.1-flash`: text and ordinary tools, reasoning off,
unknown context limit and unavailable price. `maxTokens` is a request budget, capped at 8192.

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

Child definitions, concurrency and resource ownership/cancellation rules remain reusable and tested.
Only pi execution/session bindings are replaced; restoring these libraries does not claim the full
stage-3 child Runner or MCP/Skill tool live acceptance.

Image dimensions, MIME detection and payload/request budgets remain in the pure `imageGuard` module.
Its retained tests validate those rules; the current verified text-only model does not enable vision.


## Preserved MCP management

Configuration validation, fingerprints, CRUD, per-project approval/overrides, logs/redaction and status
projection remain independent of the runner. HTTP uses the pinned SDK's public `MCPServerStreamableHttp`; stdio implements public `MCPServer`
with the official MCP client's transport so redacted stderr remains available. Management creates an owned transport, never
another model or a Pi session. The official MCP client handles discovery/DCR/PKCE with an owned token
store; callbacks and pasted replies bind to flow state and client ownership. Token files use 0600
under the application data root. Model credentials are not inherited by stdio processes; explicit MCP
authorization providers resolve only against current application model configuration.

Probe cancellation waits for its callback listener, connection and sign-in lock to close. Session
teardown invokes host-injected `setSessionResourceCleanup` before detachment; failure leaves the
session attached for retry. This avoids a dependency cycle with MCP connection state. Reconciliation
uses current project trust and exact entry fingerprints, and generations reject stale status results.
Local stdio and HTTP OAuth fixtures validate transport behavior without a live model or external login.


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

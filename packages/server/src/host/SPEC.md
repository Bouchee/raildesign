---
id: submodule-server-host
type: submodule-design
status: active
title: host — application wire and composition
parent: module-server
depends-on: [module-contracts]
tags: [host, public-surface-checked]
---

## Responsibility

The browser/host wire and composition root: Bun HTTP/WebSocket serving, static SPA, typed method
handlers, event fan-out and the boot/shutdown lifecycle shared by CLI and desktop.

## Public surface

`createServer`, `CreateServerOptions`, `RunningServer`, `bootHost`, `BootHostOptions`, `BootedHost`.

## Ownership and lifecycle

`createServer` creates/claims the data directory through `proper-lockfile` before application-state
reads/writes. A second writable host fails immediately. The lock library provides atomic acquisition,
heartbeat, stale detection and compromised-lock failure. Startup errors release the claim; failed
socket binding also clears the startup review timer and injected service callbacks. Shutdown refuses
new HTTP/WebSocket work and stops configuration watchers before cancelling resources. It waits for
accepted WebSocket requests, including abandoned replay entries, then finishes session, workspace-creation,
MCP connection/OAuth and turn cleanup. Cleanup failures are reported after all pending cleanup
settles and retain writer ownership. `shutdown()` returns the same promise on repeat calls.
Low-level `stop()` closes resources immediately while starting that same drain.

`bootHost` initializes local logging/crash recording and applies the stored environment. Login-shell
import requires explicit `resolveShellEnv:true`; an ordinary embedder/test keeps its given environment.
Exact port mode rejects a taken port; free mode searches upward. SIGINT/SIGTERM await shutdown. Fatal
uncaught faults are written locally, echoed to stderr and terminate the process; no telemetry is sent.

## Web access key methods

`webAccess.status` and `webAccess.configure` call the agent key owner and return only configured status.
The key is stored outside AppConfig and never included in settings broadcasts.

## HTTP contracts

- `/health` returns `ok`. Static assets are rooted at `staticDir`; unresolved SPA routes receive
  `index.html`. The transport host is an input, defaulting to same-origin/localhost.
- `/files/<workspaceId>/<relpath>` resolves through filesystem containment, streams current worktree
  bytes with `Cache-Control:no-store`, and answers 404 for bad ID, path escape or missing/non-file
  entries. Optional `maxBytes` rejects malformed caps with 400 and over-limit files with 413 before
  opening the body. Announced Content-Length bounds bytes even if the file grows.
- `/blob/<workspaceId>/<oid>/<relpath>` accepts a 40/64-hex immutable Git object identity and a blob
  path. Bad identities, trees/gitlinks, escapes and projectless chats are 404. A bounded `cat-file -s`
  refuses blobs over 64 MiB before content reads. The body streams Git stdout, carries immutable
  one-year cache headers, respects request/body cancellation and kills its process after five minutes.
  It does not buffer the entire blob.
- Both routes classify a bounded 8 KiB head, use the shared extension/type fallback and send nosniff.
  HTML/XHTML/SVG receive `Content-Security-Policy:sandbox; default-src 'none'`.
- `/fonts/<file>` GET serves validated user-font types with no-cache; PUT requires the non-simple
  `X-ThinkRail-Request:font-upload` header. Header absence is 403; size, count, invalid font and I/O
  errors retain their 413/409/422/500 results. Other methods, including preflight, receive 405 with
  `Allow:GET, PUT`. No CORS headers are added. Upload size is checked before and during streaming.
- `/speech` is a binary audio WebSocket tagged at upgrade and handled by the speech relay. It does
  not join JSON request replay, channel subscriptions or terminal ownership.

## WebSocket request/replay contract

`?client=` identifies a frontend surface and addresses terminal/search output. `server.welcome`
contains the protocol version, host platform, projects, config and available host/speech metadata.
The host resolves workspace/session ownership; a client key is not authentication.

`client.reportError` validates bounded report fields and writes only the closed error kind and a
recognized JavaScript error class to the local logger. Unknown classes become `Error`; supplied stacks,
boundaries and arbitrary payload text never enter logs or leave the host.

Each `(clientKey,requestId)` owns one handler promise and serialized response. Matching reconnect
replays join/return that work; conflicting fingerprints reject. A page acknowledges read replies with
`{ack:[id]}` and sends `{resume:[id]}` on reconnect. Unacknowledged successful results are not evicted.
A still-running request omitted/acked by the client becomes abandoned but remains tracked until its
handler settles; it cannot execute again. The 60-second disconnected-client reap waits until no work
is pending, then clears transport ownership. Disconnecting never cancels an agent session.

The replay cache defaults to 512 live entries, 2048 tracked entries and a 16 MiB retained-answer byte
budget. Overflow refuses new work. An oversized result may be sent once but is remembered as executed
without retaining its answer; its replay reports that the answer is unavailable, never re-executes.
Method diagnostics log only known method names or fixed `unknown method`, never raw parameters or
unregistered names. Handler errors return a typed failure and a coded error where supplied.

## Outbound backpressure

Each JSON socket has a 256 MiB outbound buffer limit; `CreateServerOptions.outboundBufferLimitBytes`
overrides it for focused transport tests. Replies larger than Bun's default 16 MiB buffer remain
deliverable, including replies queued behind them. The inbound frame limit is independent.

All JSON replies and pushes use `socketSend.sendOrQuarantine`, including subscribed fan-out,
owner-addressed MCP/search output and terminal writes. A buffered send remains live. A dropped frame
quarantines that socket with one local `WS_SLOW_CONSUMER` warning and prevents further sends. The host
closes only after its existing buffer drains, keeping the disconnected-client replay reap from starting
early. A socket still stuck after 30 seconds is terminated. Other sockets keep receiving their own
frames. The dedicated speech socket retains its separate binary relay.

`HeldSnapshots` retains only the newest unsent full assistant partial or tool-result snapshot per
session/stream on a backpressured socket. Drain and the periodic reconciler flush it even if its producer
emits no more events. Same-session non-snapshot events, normalized state and interaction frames flush
that session's held snapshots first; their original SDK `runId` and monotonic `seq` remain intact.
Fan-out still checks channel subscriptions, protocol floors and projectless-chat visibility. Session
deletion, socket teardown and quarantine discard held snapshots. Terminal output resumes only after
snapshot flushing no longer waits on the socket buffer.
Held storage has one frame per pending stream key and no separate byte budget.

## SDK session wiring

`session.stateList` coalesces full workspace scans through `trailingSingleFlight`. Requests arriving
during a scan share one trailing scan rather than the already-running result, so state changed just
before a request is not overwritten by an older scan. Only one scan runs at a time, including at its
completion boundary; a failure rejects its own callers and does not block a queued or later scan.
The completed scan keeps its slot until a queued scan starts, so promise continuations cannot race
that queued launch and start another scan alongside it.
The shared scan covers every workspace; each caller's projectless-chat visibility filter is applied
after it resolves. There is no retained result cache.

The host injects workspace-to-project and session/event/interaction publishers into the single agent
module. `session.event` includes session/run IDs and monotonic `seq`; initial message snapshots include
an `eventSeq` watermark. Approval cards use `session.interaction`, and replies carry session/run/tool/card/
revision ownership. Reply handlers attach the owning persisted session before processing, so identical
completed receipts replay after restart without prior client hydration. Missing, closing or mismatched
workspaces reject replies before continuation. SDK objects, full checkpoints and private keys remain on the host.

The event publisher feeds `TurnTracker` and emits the same application event to clients. Turns retain
actual before/after worktree snapshots; shutdown drains a still-recording receipt. Workspace watchers
publish real file changes, re-anchor reviews and invalidate search. Repo metadata changes update the
workspace HEAD/branch and invalidate branch review; watcher startup seeds HEAD conservatively.

`session.prompt` is acknowledged after accepted input, with a bounded acknowledgement window for an
immediate failure; model/tool failures after admission appear through the session stream. Workspace
kickoff returns its newly created chat after synchronous prompt admission, without waiting for the
model round. Stop delegates to agent cancellation and completes after owned execution cleanup.

Stage-2 queue, steering, compaction and recovery operations call the durable session owner. Stable input
IDs survive wire replay; queue mutation addresses the input ID. Stop preserves queued input and completes
after cleanup. Compaction carries an operation ID, and approval replies bind the tool call as well as the
interaction. Stage-3 controls use the SDK session owner. MCP configuration, validation,
per-entry approvals, OAuth, status and cleanup remain real
services through `mcp.*`. `provider.loginReply`/`provider.loginCancel` serve only owned MCP OAuth flows;
obsolete model-provider login routes remain absent. Skills catalog/trust/enable and child configuration
routes persist their actual settings. `session.getCommands` reads the current admitted Skill commands.
`session.reloadResources` validates an owned idle session, reconciles MCP and rebuilds the current SDK
tool graph before acknowledging success. Busy, pending-approval and recovery states reject reload.
No empty success snapshot, compatibility API, pi runtime, Central, telemetry or survey route remains.

Host injects the own-credential authorization resolver, project policy, addressed OAuth/status publishers,
project tool-grant writer and per-session MCP cleanup. Project grants bind the selected tool to its
approved command target or URL; the SDK consent owner rechecks the current configuration first. Trust/config mutations await probe cancellation and transport closure
before reconciliation. User MCP config changes and watched `.raildesign/mcp.json` changes reconcile
under the current trust/fingerprint policy. Session detach waits for resource cleanup; disconnected
client reap cancels only that client's MCP login. Shutdown awaits cleanup before writer-lock release.

## Workspace, terminal, review and settings composition

The host retains project/worktree creation/opening/switching, Git/PR operations, file reads, Diff,
terminal tabs, settings, history/search and prompt-template CRUD. Projectless chats are refused at
repository-only doors before Git work. A chat being deleted or pending retry cannot attach a session
or terminal. Creation handoffs reserve the default process-free terminal before clearing their marker.

State reports running, accepted terminal writes and actual HEAD movement stamp workspace activity;
viewing a row or reading a result does not. Settling is a record operation; remove is teardown. PR
mutations reactivate a workspace before network work and bind returned review identity to the branch
actually used. Branch status measures the push repository for split origins, reporting unknown when
that target cannot be read. Listing/five-minute maintenance refreshes mutable PR states with bounded
concurrency; idle-settled rows are paced at 30 minutes, user-parked rows are left alone. Detached
maintenance failures are logged and cannot become unhandled promises.

Host composes review sends with agent sessions and serializes review/change operations per workspace.
SDK Todo/Spec Graph tools use their existing stores. Resource routes read owned command logs and child
transcripts; historical message text grants no access. History
scope labels/readers are injected by host, as are search readers and filesystem preflight checks.
Settings changes persist in their owner and broadcast a full merged config. Layout/focus/placement
stay frontend-local. Native actions remain in their own services rather than agent/Git/PTY execution.

Terminal output uses addressed sends, bounded batching and a backpressure latch. Drain is the fast
resume path; a one-second reconciler also resumes latched clients whose buffered byte count is zero,
covering sleep/lost-drain cases. A disconnected/replaced socket cannot resume another client's output.
Broadcast channels must be subscribed at open. Terminal data/exit/detach and search results are
addressed rather than broadcast. Session/project/workspace/settings/review/turn/theme/font/locale
channels use their injected owners, keeping all cross-module wiring here.

## Validation and tests

`boot.test.ts` covers ports, SPA, writer refusal/release/startup failure, environment policy, update
single-flight/lifecycle and shutdown. Route tests cover byte caps, security headers, symlinks and real
streaming. Chat/workspace tests cover ownership, delete races, record recovery and Git limits. Turn
shutdown tests hold an unfinished receipt to verify draining. Handler tests preserve actual workspace,
Git, PR, template and send behavior; retired service assertions are removed with their implementations.


## Preserved agent-facing application services

`titleTool` keeps naming as an application service with explicit dependencies. Automatic naming uses
`renameSession(...,{onlyIfUnnamed:true})` atomically, so an existing/manual chat title is retained.
Workspace names are set once, are bounded at word boundaries, and retain the pending branch-move
ownership rules for detached or externally switched HEAD. The host injects these services into the SDK
title tools and resets the injection during teardown.

`workspaceTools` keeps open-project/model selection, image/file attachment preparation, self-contained
kickoff prompts, creation cancellation/error reporting and bounded status/final-message rendering.
Its default dependencies use current application/SDK services and its focused tests inject those same
capabilities. A projectless chat must select an open repository; the Chats container is excluded.

`continuations` binds each Continue gesture to its source chat and target open repository. Concurrent
gestures for the same target join; another target is refused until settlement. A durable custom host
message asks the source SDK agent for a bounded summary, queued after running work. Only the bound
source session's grant-bound `continue_in_workspace` call may create the target workspace and its SDK
chat. Its host-owned run input ID must match the bound request's operation ID; an older queued request
cannot fulfill a new gesture after restart. The existing creation owner receives cancellation; source, target and grant are rechecked across
awaits. Parallel calls join one apply. A failed attempt can reuse its surviving workspace on Retry.
The target receives a custom handoff message rather than a fabricated user turn. The source's
`continuedTo` link preserves successful status across restart; unfinished operations become unknown
and require a fresh user gesture. Stop or a settled source without a summary fails the operation.
The host broadcasts phases, clears held operations during teardown, and retains no Pi execution path.
The durable link is committed before target input admission, so a delivery failure reports a created
destination rather than inviting a duplicate creation. A pre-link cancellation removes a newly created
unused session; it preserves an already-published workspace that another client may have edited and
reports that Retry reuses it. The shared chat-start helper performs the same unused-session cleanup
when a creation claim is revoked, without replacing the original failure if cleanup fails.

`requestReview` retains host-stamped verdict parsing, normalized finding/reading-order paths, stripping
of model-supplied host-only flags, item-title lookup across all plan collections, and result text that
respects blocked approvals and the automatic-fix budget. Host startup installs the review/resolve tool
handlers and failure publisher. `todo.startReview`, `todo.reviewAll` and `todo.requestFix` validate the
parent session's workspace and invoke the same review owner. Artifact settlement triggers eligible
automatic re-review. Shutdown clears these injected handlers and publishers. The independent reviewer,
findings and compensation contracts live in [planReview.SPEC.md](planReview.SPEC.md).

The host publishes owned resource lifecycle changes and routes parent-addressed child approvals through
`attachApprovalOwner` before applying the original interaction receipt.

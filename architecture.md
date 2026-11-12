---
id: architecture
type: architecture-design
status: active
title: RailDesign — top-level architecture
parent: goal-and-requirements
covers: [client-host-split, cli-entrypoint, wire-contract, transport-endpoint, ui-shell-panels, git-worktrees, remote-tailscale, hydrate-then-stream, domain-vs-view-state, frontend-local-workbench-frame, client-local-navigation, central-integration, portable-pi-packages, thinkrail-extensions]
tags: [architecture]
---

## Drivers

RailDesign keeps the workbench and Git workspaces from ThinkRail while replacing the execution kernel
with the OpenAI Agents SDK. The host owns application state and persistence. The SDK owns model calls,
the agent loop and tool dispatch. Use one execution path; do not preserve pi readers, adapters or fallback engines.

Stage 1 supplies the first edit/command/approval/Stop workflow. Full session recovery and model-summary
compaction follow in stage 2. Advanced tools follow in stage 3. Complete dependency removal and desktop
artifacts follow in stage 4. Private server deployment follows in stage 5. These later gates are not
established by a source build. Controls for unavailable tools stay disabled.

## Topology — three rings

```text
apps/web              React workbench; application state projection and presentation
                      depends on contracts, locales, ui, resource-renderers and extension web halves
packages/contracts    application-owned messages, events, methods and versioned wire
packages/server       SDK execution + filesystem, Git, workspaces, PTY, approvals and persistence
packages/shared       server-side platform utilities, paths, release identity and native icons
apps/cli              raildesign browser launcher and standalone binary
apps/desktop          Electrobun native shell over the same host and web artifact
```

The browser never imports server/shared code, SDK runtime, keys or full RunState. Server modules expose
an `index.ts` barrel; their parent SPEC owns dependency edges. Launchers supply lifecycle, endpoint,
native actions and physical assets. Agent, Git and PTY behavior lives in shared host services.

## Decisions

1. **Client/host split.** The wire is the only coupling. SDK objects enter one server projection and
   leave as application-owned messages, tool calls, usage and session state. Keep stable session, run,
   message, tool and interaction IDs. Each `session.event` carries a monotonic sequence number.
2. **One execution owner.** Only one Runner may operate in a session. A run has fresh tools,
   AbortController and workspace-bound grant. Model and tools use the selected worktree. Completion
   requires full settlement with no error, cancellation or pending interaction.
3. **Versioned wire and hydration.** `server.welcome` carries the protocol version. Subscribe before
   fetching a session snapshot, buffer events, then apply only events above its watermark. Flush stream
   batches before finals and unrelated replies. Append deltas and correct finals on the same message.
4. **Endpoint is a parameter.** The browser defaults to same-origin HTTP/WebSocket. Native route and
   preference persistence is qualified by backend profile; the desktop's dynamic loopback port is not
   persisted as a host identity.
5. **Window-local layout.** Panels are layout-agnostic. Each window owns its layout, navigation and
   focus. The host owns domain state. Workspace resources never move another window's panels.
6. **Workspaces are real Git worktrees.** A project owns workspaces with their own branches and cwd.
   The explicit Default workspace uses the project directory; attached external worktrees stay
   user-owned. Projectless chats live in application-owned scratch folders. Git/PR, editor, Diff,
   watcher and turn-snapshot services inspect the same actual filesystem as the agent.
7. **Tools reuse host services.** Ordinary SDK FunctionTools wrap filesystem/search, bounded commands
   and validated patch application. Check lexical paths, realpaths, symlinks, new-file ancestors,
   `.git`, original text and the current run grant before edits. Keep subprocess timeout/output bounds.
   Stop revokes the grant before aborting the model and owned process tree. Old callbacks cannot write
   or launch tools after revocation. Approval decisions bind session/run/interaction/revision.
8. **Host-owned records.** RailDesign starts with new records under `~/.raildesign`. Model history and
   full display transcript have distinct purposes. Persist important tool/interaction states before
   side effects. Interrupted or unknown effects never replay automatically. Do not read or migrate
   upstream app data, pi sessions, credentials or plugins.
9. **Model configuration stays on the host.** Use a protected key and a verified Responses-compatible
   endpoint through the same SDK model path. The stage 0 target is OpenCode Go's
   `deepseek-v4.1-flash`. SDK usage supplies token counts; unavailable pricing remains unavailable.
   Tracing starts disabled. Credentials are not passed automatically to subprocesses or MCP children.
10. **Dependency policy.** Pin exact versions. Cross-cutting dependencies live once in the root
    workspace catalog and consumers use `catalog:`. Keep internal `@thinkrail/*` package names.
    Prefer existing services and installed dependencies to new wrappers or libraries.
11. **Terminal ownership.** The host owns workspace-scoped PTYs; the browser renders them with xterm.
    A terminal belongs to a tab. Native launchers do not own a separate terminal implementation.
12. **Engine-neutral review.** Resource renderers and anchored review comments work through their
    documented public seams. Changing the execution kernel does not justify moving renderer or Git
    business logic into the desktop shell.
13. **Independent product identity.** Product name is RailDesign; identifier is
    `io.github.bouchee.raildesign`; CLI executable is `raildesign`; default data is `~/.raildesign`.
    Install metadata/cache and icons are independent of official ThinkRail. The fork is
    `https://github.com/Bouchee/raildesign`; desktop updates use its
    `releases/download/desktop-updates` channel only. Release signing uses fork-maintainer identities.
    Development source changes do not establish installation/update/signing acceptance.
14. **Local diagnostics.** No JetBrains service configuration, PostHog keys, attribution, consent UI
    or surveys ship. Keep host diagnostics local. Model tracing remains a separate explicit opt-in.
15. **Desktop packaging.** Native resources remain physical and unpacked. Stage PTY FFI libraries
    before importing the host. Leave the replaceable app bundle before spawning children. The shell
    owns windows, native actions, microphone permissions, updates and local host lifecycle only.
16. **Presentation standards.** User-facing text comes from keyed locale catalogs. Preserve semantic
    theme tokens, accessibility and reduced-motion behavior. User locale/theme/font files live below
    the RailDesign data directory. See owning UI and locale SPECs for detailed contracts.

## Verification

Use disposable fixtures and run focused tests during implementation. Before app handoff run repository
lint/typecheck/boundary gates and the complete no-agent browser suite once. Changed agent behavior also
needs a focused isolated live check. The full live suite requires user approval. Artifact and platform
acceptance remain separate from source tests.

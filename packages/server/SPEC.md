---
id: module-server
type: module-design
status: active
title: Engine host (server library)
parent: architecture
depends-on: [module-contracts, module-shared]
tags: [host]
references: [module-artifact-tests]
---

## Bundled extension helpers

The server registry composes SDK questions, visualization and DeepSeek web tools through extension-api.
Question and visualization schemas live in pure helper packages; the server imports their public
extension entries rather than those helpers directly. Other bundled tool packages retain their current owners.

## Responsibility

The embeddable Bun host serves the application HTTP/WebSocket protocol and owns workspace services
and RailDesign state. CLI, desktop and development entries launch the same host. The installed OpenAI
Agents SDK owns model calls, the agent loop and FunctionTool dispatch. There is one execution path.

## Boundary

- `createServer(options) -> Promise<RunningServer>` returns `{port,stop,shutdown}`. Only one writer may
  own a data directory. The host acquires a `proper-lockfile` claim before application-state access;
  startup failure releases it, while successful shutdown releases it after sessions and turn receipts
  drain. `shutdown()` is idempotent. Low-level `stop()` closes resources synchronously and starts the
  same drain before releasing ownership.
- `bootHost(options) -> BootedHost` installs local crash logging, optionally imports the login-shell
  environment, applies saved environment variables, resolves the requested port and installs signal
  cleanup. Login-shell import is opt-in (`resolveShellEnv:true`).
- The root barrel exports host APIs, `dataDir`, `setBundledSkillPaths` and `setBundledTrashHelpers`. Build-only
  `@thinkrail/server/build-support` supplies Skill content roots, native PTY libraries and trash helpers. The `/agent`
  subpath exposes the production session surface to isolated tests; `/history-test-fixtures` exposes
  test-only application-record builders. The development entry is `src/dev.ts`.
- Main dependencies are contracts/shared, the locked Agents SDK and OpenAI client, Zod, Bun PTY,
  local logging, `proper-lockfile`, YAML and existing pure graph/Todo services. No pi runtime,
  credentials, Central service, telemetry or survey is initialized by a product entry.
- Feature behavior belongs in its owning module; launchers supply boot options and native assets.
  Browser code never imports server/shared internals or receives model keys/full SDK checkpoints.
  Feature modules cannot import `host`, web, CLI or desktop.

## Internal modules

Each lives in `src/<name>/` as a bounded sub-module: a `SPEC.md` (its own boundary) + an `index.ts`
**barrel** that is its only public surface. Siblings import a module **through its barrel, never its
internals**. The edges between them are owned here (see the dependency graph), not in the leaf specs.

| module | owns | spec |
| --- | --- | --- |
| `host` | `Bun.serve` HTTP+WS, static SPA, the WS dispatch registry, channel publish | [host/SPEC.md](src/host/SPEC.md) |
| `persistence` | JSON domain/config state under the data dir | [persistence/SPEC.md](src/persistence/SPEC.md) |
| `log` | explicit leveled diagnostics → pretty stderr + agent-oriented JSONL under `<dataDir>/logs` (pino-roll daily/10 MB rotation, 14 rotated + active); arbitrary console output stays terminal-only | [log/SPEC.md](src/log/SPEC.md) |
| `settings` | server-synced app config, including the shared custom-layout-preset catalog (never current/default layout) | [settings/SPEC.md](src/settings/SPEC.md) |
| `environment` | the stored host environment (variables) applied to `process.env` at boot | [environment/SPEC.md](src/environment/SPEC.md) |
| `locales` | the user's local language files in `<dataDir>/locales/`: validate, watch, `locales.list`/`changed` | [locales/SPEC.md](src/locales/SPEC.md) |
| `themes` | the user's theme files in `<dataDir>/themes/`: read, watch, `themes.list`/`changed` (the client validates) | [themes/SPEC.md](src/themes/SPEC.md) |
| `fonts` | the user's font files in `<dataDir>/fonts/` (in-house sfnt reader, uploads, watch) and the OS's installed families: `fonts.list`/`installed`/`changed` | [fonts/SPEC.md](src/fonts/SPEC.md) |
| `speech` | on-demand local voice input: pinned `nemo-speech` + Nemotron download, PATH reuse, `speech.*` state | [speech/SPEC.md](src/speech/SPEC.md) |
| `projects` | stable known-repo registry: open/recent views + lossless close/reopen (validate, dedupe, slug) | [projects/SPEC.md](src/projects/SPEC.md) |
| `workspaces` | workspaces = `git worktree`s on their own branch | [workspaces/SPEC.md](src/workspaces/SPEC.md) |
| `git` | the `git(cwd, args)` runner + worktree status/diff vs base + branch list | [git/SPEC.md](src/git/SPEC.md) |
| `subprocess` | `runBounded(argv, …)`: one child, one budget, killed by process group on expiry | [subprocess/SPEC.md](src/subprocess/SPEC.md) |
| `github` | read-only local `gh` auth status (shell-out) for the New-Workspace surface | [github/SPEC.md](src/github/SPEC.md) |
| `branch-review` | best-effort GitHub PR / GitLab MR for a workspace branch, with an open PR's checks, review decision, and merge state | [branch-review/SPEC.md](src/branch-review/SPEC.md) |
| `pr` | `pr.open` / `workspace.push`: push the workspace branch + open/update its GitHub PR, body from the plan, commits, or a template; ready / merge / reopen it and delete its remote branch | [pr/SPEC.md](src/pr/SPEC.md) |
| `fs` | read dirs/files inside a worktree (path-contained) + the one byte classification (text/mime/sha-256) | [fs/SPEC.md](src/fs/SPEC.md) |
| `changes` | host-owned revert of a hunk or a file's whole change in the worktree, with undo receipts | [changes/SPEC.md](src/changes/SPEC.md) |
| `turns` | per-agent-run worktree snapshots → the change set each run produced (`workspace.turns`, `turn.changed`) | [turns/SPEC.md](src/turns/SPEC.md) |
| `trash` | move a path to the OS trash through the bundled helpers (never `unlink`) | [trash/SPEC.md](src/trash/SPEC.md) |
| `resourceHistory` | the durable per-chat archive of background commands and subagents behind Resources (records + command log tails) | [resourceHistory/SPEC.md](src/resourceHistory/SPEC.md) |
| `spec` | the worktree's spec-graph snapshot (`spec.graph`) + project-level `projectHasSpecs`, via `@thinkrail/spec-graph/core` | [spec/SPEC.md](src/spec/SPEC.md) |
| `todos` | a chat's per-session TODO plan read/write (`todo.*`), via `@thinkrail/todos/core` | [todos/SPEC.md](src/todos/SPEC.md) |
| `reviews` | draft review comments on files/diffs: store + anchoring + context-package render | [reviews/SPEC.md](src/reviews/SPEC.md) |
| `watch` | per-worktree fs watcher → debounced `workspace.fsChanged` invalidation push | [watch/SPEC.md](src/watch/SPEC.md) |
| `terminal` | workspace-scoped `bun-pty` terminals | [terminal/SPEC.md](src/terminal/SPEC.md) |
| `agent` | SDK Agent/Runner sessions, application records, tools and one-shot completions | [agent/SPEC.md](src/agent/SPEC.md) |
| `extensions` | the server registry of ThinkRail extensions (`@thinkrail/ext-*/server`): ordered descriptors + public specifiers, inline flattening, owner-scoped skill resolution | [extensions/SPEC.md](src/extensions/SPEC.md) |
| `auth` | redacted status for configured SDK endpoints | [auth/SPEC.md](src/auth/SPEC.md) |
| `assist` | ad-hoc one-shot tasks (plan summaries, PR descriptions) on a cheap model, best-effort | [assist/SPEC.md](src/assist/SPEC.md) |
| `dialog` | the host's native folder picker | [dialog/SPEC.md](src/dialog/SPEC.md) |
| `editors` | detect installed editors/IDEs, launch one at a worktree, reveal a worktree in the file manager | [editors/SPEC.md](src/editors/SPEC.md) |
| `history` | prompt recall and conversation search over full RailDesign transcripts | [history/SPEC.md](src/history/SPEC.md) |
| `search` | the search palette's host providers (file names and specs from one root, plans, chat transcripts — chats and workspaces are the palette's own rows) and the transcript preview, ranked with the shared matcher; Find in Files' bounded text search over the same root | [search/SPEC.md](src/search/SPEC.md) |
| `templates` | file CRUD over RailDesign prompt dirs (global + project scoped) | [templates/SPEC.md](src/templates/SPEC.md) |

## Internal dependency graph

`host` is the composition root. Every sibling call uses the owning barrel.

- `host` composes project/workspace/Git/PR/filesystem/editor/terminal services; agent/auth/assist;
  settings/environment; history/search/templates; themes/fonts/locales/speech; watch/reviews/turns;
  and the retained pure Spec Graph/Todo/extension metadata services.
- `agent` -> `fs`, `subprocess`, `persistence`, `trash`, `log`. Tools validate their assigned worktree;
  commands use bounded execution; transcript deletion uses recoverable trash. Agent never imports host,
  auth or settings. The host injects session publishers and resolves session-to-project ownership.
- `auth` -> `agent` for redacted configured-endpoint status. `assist` -> `agent` for the same SDK
  one-shot path. Neither module implements another model runner.
- `projects` -> `git`, `persistence`; `workspaces` -> `projects`, `git`, `persistence`.
- `git` -> `subprocess`, `fs`; `branch-review` -> `git`, `subprocess`; `github` -> `subprocess`.
- `pr` -> `workspaces`, `git`, `todos`, `branch-review`, `github`. The host composes PR-description
  generation with assist so PR does not gain an assist edge.
- `changes` -> `git`, `fs`, `persistence`, `trash`; `turns` -> `git`, `persistence`, `log`.
  Host supplies agent events to turns; turns never imports agent.
- `reviews` -> `workspaces`, `persistence`, `git`, `fs`; host composes review sends with agent and
  serializes changes/review mutations per workspace. Advanced review-tool execution is unavailable.
- `todos` -> `workspaces` and the existing pure TodoStore. `spec` uses the existing pure graph core.
- `search` -> `git`, `log`, with host-injected project/workspace/history/spec/plan/file readers.
  Host injects history scope filters/labels; history never owns project registries.
- `history` -> `persistence` for the session root; `templates` -> `persistence` for prompt roots and
  the installed YAML library. Both read only RailDesign data.
- `environment` -> `persistence`, `log`; `settings` -> `persistence`.
- `speech` -> `subprocess`, `persistence`, `log`; `fonts` -> `subprocess`, `persistence`.
- Filesystem/watch/terminal/locales/themes/resource-history services use persistence for their own
  records. `log` is a cross-cutting dependency backed by persistence; persistence does not import log.
- The retained extension metadata registry consumes server extension descriptors. It does not register
  pi factories or load skills into the SDK during stage 1. Advanced tools require stage-3 integration.

Push-capable services expose injected publishers; they never reach back into host. Current layout,
workspace placement, navigation and focus remain frontend-local. Host initialization reserves the
process-free default terminal and clears a workspace creation marker only after durable catalog success.

## Get right

- SDK/provider faults have no process isolation; fatal faults may terminate the host (accepted).
- Keep a single writable owner. A second host must fail before it mutates application records.
- Await graceful shutdown in production. Stop revokes agent grants and cancels owned processes; turn
  receipts drain before resource disposal and writer-claim release.
- Commands return direct results; application events and interaction cards use typed push channels.
- Session storage is fresh RailDesign JSON. No pi import, old-record reader, migration or alternate
  execution fallback is supplied.
- Tests use disposable directories and isolated home variables. They never use ambient developer
  credentials or run a provider unless the focused live gate was explicitly selected.

Stage 2 owns full session recovery, queues and summaries. Stage 3 owns advanced tools. Stage 4 owns
complete legacy package removal and release-artifact acceptance; the presence of retained pure service
code does not establish those later gates.

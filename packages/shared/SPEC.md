---
id: module-shared
type: module-design
status: active
title: Shared server-side utilities
parent: architecture
depends-on: [module-contracts]
tags: [host]
---

## RailDesign identity and execution

RailDesign uses `io.github.bouchee.raildesign`, new state under `~/.raildesign`, the `raildesign`
CLI, and updates from `https://github.com/Bouchee/raildesign/releases/download/desktop-updates`.
The SDK execution path belongs to the shared host. Launchers contain native startup and packaging only.
No JetBrains service, PostHog key, attribution or survey integration ships in development builds.
The fork does not import the official application's records or configuration.

## Responsibility

Cross-cutting runtime utilities used by the engine host and its launchers. Server-side only — never
bundled into `apps/web`. Exposed through explicit subpath exports, not a barrel.

## Boundary

- **Owns:** host-side runtime helpers that are neither engine- nor transport-specific, and the native
  brand icon set both launchers ship (`assets/` and its generator, `scripts/generate-icons.ts`).
- **Public surface:** `@thinkrail/shared/shellEnv` → `resolveShellEnv()`, `repairShellEnv()`, `mergePath()`,
  `loginShellImports()`, `parseLoginShellEnv()`, `LOGIN_ENV_MARKER`, `localeRepair()`, `launchEnvKeys()`;
  `@thinkrail/shared/freePort` → `findFreePort()`, `isPortFree()`, `parsePort()`;
  `@thinkrail/shared/startupMark` → the static recursive wordmark plus the pure responsive/ANSI renderer
  and interactive-output gate used by every launcher;
  `@thinkrail/shared/version` → the baked `{ version, channel, commit }` release identity shared by CLI,
  desktop, and host provenance (with a committed `0.0.0-dev` source default);
  `@thinkrail/shared/windowsIdentity` → `windowsFileIdentity()`, the Windows file properties both
  launchers stamp on their executables, `windowsProductName()`, the per-channel product name alone, and
  `windowsIconPath`, the ICO they embed;
  `@thinkrail/shared/paths` → the worktree-relative path conventions (`WORKSPACE_INTERNAL_DIR`,
  `WORKSPACE_CONTEXT_DIR`, `WORKSPACE_TODOS_DIR`);
  `@thinkrail/shared/codedError` → `CodedError` + `errorCodeOf()`;
  `@thinkrail/shared/toolHomes` → `toolHomeEnv(home)`, the environment that points every agent tool's
  config home (Claude Code, Codex, Gemini, Copilot, Kimi, Grok) under one sandbox home and clears the
  overrides that would reach outside it — the single list every hermetic host spawner (e2e, workflow
  harness, artifact probes) applies, so a new detection source cannot leak the developer's real sign-ins;
  `@thinkrail/shared/removeTree` → `removeTree()`, the retrying recursive remove every teardown of a tree
  a child process ran from goes through;
  `@thinkrail/shared/spawn` → `spawnSyncCaptured()` + `spawnSyncCapturedBytes()` + `spawnDetached()`, the
  hidden-child-process seam every console child the host or CLI launches goes through;
- **/spawn** — `spawnSyncCaptured()` (sync capture → `{ launched, exitCode, timedOut, stdout, stderr }`;
  `timeoutMs` runs the child in its own process group (POSIX), sends the child `SIGTERM` at the deadline
  and, once it exits, `SIGKILL`s the whole group, so grandchildren holding a hang (a hook, an ssh helper)
  die with it; `SIGTERM` first lets git remove its `.lock` files, which a `SIGKILL` would leave behind and
  so lock the repo for every later write; a direct child that ignores `SIGTERM` is not bounded; it sets
  `timedOut`, so a caller can name a hang rather than read it as an ordinary nonzero exit. A child in its
  own group misses the terminal's Ctrl-C, and the blocked host cannot run its `SIGINT` handler until the
  child exits, so when the host has a controlling terminal a small `/bin/sh` supervisor stays in the
  host's group, starts the command in a new group (`setsid`, else `set -m`) and turns Ctrl-C, a terminal
  hang-up or a quit into a group `SIGTERM`, so closing the terminal never orphans a hung command. Without a terminal the child is spawned detached directly, so the desktop host pays
  no extra fork),
  `spawnSyncCapturedBytes()` (the same launch and exit semantics with **`stdout` left as bytes**, for a
  caller reading binary child output the UTF-8 decoder would replace — stderr stays decoded text, since a
  diagnostic is only ever read as text) and
  `spawnDetached()` (fire-and-forget `unref`) over `Bun.spawnSync` / `Bun.spawn`, always
  `windowsHide: true` except where a `spawnDetached` caller passes `windowsHide: false` to launch a GUI
  app whose own window is the point (the file-manager reveal). Bun 1.4.0 maps that option to libuv
  `UV_PROCESS_WINDOWS_HIDE`; the seam prevents background console spawns from omitting it. The two
  bespoke bounded runners (`server/subprocess` `runBounded`) sets it directly.
- **Allowed deps:** Bun/Node runtime, contracts types, and build-only icon dependencies.
- **Forbidden:** importing `server` / `web` / any `pi` package; being imported by `web` (it carries
  Bun/Node code that must not reach the browser bundle).

## Contents

- **/shellEnv** — `resolveShellEnv()` (one cached async run per process; `repairShellEnv()` is the
  uncached worker that tests drive with an injected probe, and `loginShellProbe(timeout)` builds the
  default probe with a test-sized deadline): make the host's environment safe for the shells it spawns,
  because a GUI-launched host (Finder/Dock, launchd, a systemd unit, a container) inherits a
  stripped-down one. Four independent repairs:
  - **`PATH`** — always adopt the user's login PATH so the in-process agent's bash/tools and the git hooks
    they trigger find `git`/`node`/`bun`/etc., keeping whatever the launching terminal had added on top.
  - **login-shell environment** — import the rest of the user's login-shell environment once at startup,
    VS Code-style, because a GUI-launched host otherwise sees none of the variables that provider API keys
    and `models.json` / `mcp.json` `${VAR}` references (often copied from vendor docs) rely on. Skipped
    when `TERM` is set (a host launched from a terminal already carries the shell's environment). Variables
    already set for the process win; `PATH` keeps its own repair above; `PWD`/`OLDPWD`/`SHLVL`/`_` and
    `PI_*` / `THINKRAIL_*` are never imported (a pi config folder or `PI_*` variable the user wants comes
    from the stored host environment instead, [[submodule-server-environment]]). One marker-delimited `env -0` probe of the login shell
    (`-l -i`, then `-l`) serves both this import and the PATH repair; rc-file chatter before the marker
    (`LOGIN_ENV_MARKER`) is ignored. Trade-off recorded: the host, every process it spawns (stdio MCP
    servers included) and every `!command` resolution then see the secrets the shell exports — the user's
    own, as in a terminal, not isolation.
  - **locale** — set `LANG` to a UTF-8 locale when *no* locale is configured at all (`LC_ALL`, `LC_CTYPE`
    and `LANG` all unset). Without one, bash/readline is **byte**-oriented rather than character-oriented,
    so one backspace over a multi-byte character (Cyrillic, umlauts, CJK) deletes half of it and desyncs the
    line. Only `LANG` is set, never `LC_ALL`, so a user's per-category settings (`LC_NUMERIC`, `LC_TIME`, …)
    survive.
  - **`SSH_AUTH_SOCK`** (darwin only) — when absent, recover the launchd ssh-agent socket via
    `launchctl getenv SSH_AUTH_SOCK` (3s timeout, never throws, no-op when launchd reports none).
    Without it both the host's own git pushes (`pr`) and every embedded terminal lose the user's
    ssh-agent: `ssh-add` inside a RailDesign terminal answers "Could not open a connection to your
    authentication agent", and a key loaded in Terminal.app never reaches the host's push.

  All repairs land on `process.env`, which is what makes them reach *every* shell the host spawns: the PTY
  terminals copy it (`server/src/terminal`), and so does the in-process agent's own bash.
- **/freePort** — `findFreePort(preferred, host?)`: the first free port at or above `preferred`, so a
  host can pick an open port instead of colliding with one already running. `isPortFree(port, host?)`:
  the underlying single-port check. `parsePort(value)`: strict port parse (plain decimal digits, 0-65535, else `undefined`), so an empty,
  `0x10`, `1e3` or out-of-range `THINKRAIL_PORT` is ignored instead of becoming port 0 or `NaN`.
- **/startupMark** — the launchers' one boot signature: a committed 42×20 `RD` silhouette built from a
  cyclic `RAILDESIGN·` field, composed with the product identity, a caller-supplied honest status, and its
  resolved endpoint. At 72+ columns it is a right-hand lockup; from 42–71 it stacks, and below 42 it uses
  the identity/status alone rather than wrapping the artwork.
  Rendering is one synchronous write's worth of text: terminal-palette green + sparse bright signals +
  dim separators when ANSI is allowed, plain UTF-8 for `NO_COLOR`/`TERM=dumb`, and no mark at all for
  non-interactive stdout. The root dev runner calls it before spawning concurrent tasks (`starting`);
  the source/compiled CLI calls it after `bootHost` resolves the actual URL (`host ready`). SVG/image
  conversion is never a runtime concern.
- **/version** — the one permanent release-stamping seam. Source runs report `0.0.0-dev`; release CI
  overwrites this module in its throwaway checkout before building either artifact family so CLI
  `--version`, desktop package metadata and `server.welcome.appVersion` cannot drift. It contains release identity data and has no launcher dependency.
- **/windowsIdentity** — `windowsFileIdentity({ version, channel })`: what Windows shows for a RailDesign
  executable. The product name, which also serves as the file description Task Manager displays, is
  `RailDesign` on stable, `RailDesign Nightly` on nightly and `RailDesign Dev` on unstamped builds. The
  publisher and copyright are Bouchee, as in `LICENSE` and the signing certificate. The version
  takes the four numeric parts Windows requires: `X.Y.Z` plus the prerelease's trailing number
  (`0.3.0-nightly.6` → `0.3.0.6`), else `.0`. An unknown channel or a part above 65535 throws, so a
  release build fails rather than ship wrong properties. The CLI compile, the desktop `postBuild` and
  both Windows smokes (CLI and desktop) derive from it, so they cannot disagree. The mapping is lossy
  by design: a stable `0.3.0.0` sorts below the nightlies `0.3.0.N` that preceded it, since four numbers
  cannot say "pre-release". That order is never compared: stable and nightly are separate installs that
  never replace each other's files, no MSI versioning is involved, each channel's own sequence is
  monotonic, and the product name already tells the channels apart. Encodings that force the order
  (`.65535` for stable, nightlies under the previous patch) only misreport the version, so they are
  rejected.
- **/assets** — the native icon set: the hand-authored `icon.svg` and the rasters generated from it.
  Never hand-edit a raster; regenerate them with `bun run --cwd packages/shared generate-icons`
  (`@resvg/resvg-js` rasterizes straight from the vector, `resedit` packs the ICO). The outputs are the
  macOS iconset, the Linux 512 px PNG, and the Windows ICO, whose path `windowsIconPath` exports.
  - **Artwork.** The new RD mark uses a rounded-square silhouette: the RailDesign RD glyph in the dark-family
    brand green (`#8dff4f`) on a solid black tile. Translucent glass, highlights, and decorative edging
    are excluded so small taskbar frames stay crisp.
  - **ICO frames.** PNG-compressed at 256/128/80/72/64/56/48/40/36/32/28/24/20/16: Microsoft's
    documented minimum (16/24/32/48/256), plus 64/128 and every small and big icon size Windows asks for
    between 125% and 250% scaling. `LoadImage` picks the closest frame that does not exceed the requested
    size, so a missing size would be upscaled and blurry. An earlier 4-frame BMP ICO lacked the Windows
    11 taskbar's 24 px frame and read as blurry there.
  - **Frame order.** Frames are ordered largest first, because Bun's compiler keeps a named icon group
    that maps only icon #1 (oven-sh/bun#32428, [[module-cli]]).
- **/codedError** — `CodedError(code, message)` + `errorCodeOf(err)`: an error carrying a wire
  `WsErrorCode`, so a failure a client must react to *specifically* travels as a name rather than a string
  to pattern-match. It lives here because both ends of the seam need it and neither may import the other:
  the module that knows the failure throws it (today `server/src/git`, for a vanished commit scope) and the
  host's request handler reads it onto `WsResponse.errorCode`.
- **/removeTree** — `removeTree(path, options?)`: delete a tree that a child process ran from, and keep
  trying while the failure is one a short wait can resolve (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`,
  `EPERM`, `EACCES`) — ten attempts with a linear 100 ms backoff by default. It exists because Windows
  releases executable handles asynchronously after a child exits, so a bare recursive remove of a
  smoke/e2e temp tree throws `EBUSY` *after* every assertion has already passed, and because **`rmSync`'s
  own `maxRetries`/`retryDelay` are inert under Bun** — nightly run 33166583594 threw `EBUSY` 252 ms after
  printing `installer smoke OK` under a policy that mandated seconds of backoff. `EACCES` joined the
  retryable set after nightly run 33949193053: the same not-yet-released handle surfaces as `EACCES` as
  often as `EBUSY` on Windows. The retry is teardown resilience, not error suppression: a tree still
  locked past the backoff throws, and a failure no delay can fix (`ENOTDIR`, …) throws on the first
  attempt. `options.remove` is the injected-remover seam the unit test drives; `attempts`/`delayMs` let a
  caller trade patience for speed.
- **/paths** — the worktree-relative path conventions RailDesign owns, named once so current and future
  consumers agree (today: `workspaces` *creates* the scratch dir and git *ignores* it):
  `WORKSPACE_INTERNAL_DIR` (`.raildesign` — the repo-local host-managed dir, today holding the ephemeral
  scratch, the intended home for future host files like a cached spec index; **not** hidden from the file
  tree), `WORKSPACE_CONTEXT_DIR` (its `context/` scratch dir for temp docs), and `WORKSPACE_TODOS_DIR`
  (`context/todos/` — the chat TODO plans, one JSON per session, so they're ephemeral with the rest of
  the scratch). The pi-free `pi-todos/core` can't import this package (it stays vanilla-`pi`-installable),
  so it keeps a local mirror of the todos path; this module is the host-side source of truth. Distinct
  from the *home* state dir `~/.raildesign` (server `persistence`). (The `.gitignore` *body* the host seeds
  into the scratch dir — a lone `*` — is a one-off inlined at that call site, not a path, so it lives
  there, not here.)
## Get right (shellEnv)

- Runs **once at startup, before creating any `AgentSession`**.
- **Launch keys are snapshotted before any repair.** The first `resolveShellEnv()` call records the
  names already in `process.env` (same `Symbol.for` state, so bundled copies share it); `launchEnvKeys()`
  returns that set, or the current names when no repair ever ran. The stored host environment
  ([[submodule-server-environment]]) uses it so an explicit launch variable beats the stored record while
  a login-shell import or locale repair does not.
- **Async, one run per process, awaited before the first spawn.** `resolveShellEnv()` returns one
  promise cached on a `Symbol.for` global key, so every caller awaits that same run, even from a second
  bundled copy of the module (the desktop shell and its server bundle). A GUI launch pays for the login
  shell (~100 ms typical, seconds with nvm/conda), and a sync probe stalls the whole boot for it. The
  async probe lets a launcher overlap it with work that spawns nothing (bundle import, logging init) and
  await it before the first spawn.
  Gating each spawn site instead was rejected: the sites are many (git, PTY, editors, tools and extensions), and a missed one silently gets the stripped PATH. The login-shell and `launchctl` probes
  run in parallel; the `launchctl` `SSH_AUTH_SOCK` applies only when the login-env import did not set it.
- **Output counts only up to its end marker.** The probe prints `LOGIN_ENV_END` after `env -0`, and output
  without it is a failed probe, so a cut-off read never applies a truncated `PATH` or silently drops
  variables. Bytes after the marker are drained and discarded until the shell exits, because an EXIT trap
  or logout file that writes more than the pipe buffer would otherwise block the shell until the deadline.
  Once the shell has exited with the marker read, the read is cancelled, so a background job that an rc
  file leaves holding the pipe cannot hold the run open. A 100ms bound after the exit only covers a shell
  that exits without the marker while such a job keeps the pipe open.
- **The deadline kills the whole probe.** The shell starts in its own process group, and at 5s the group
  gets SIGKILL: interactive zsh and bash ignore the default SIGTERM, and a hung rc command would outlive
  its shell.
- No-op on win32 (GUI processes already inherit the registry PATH). Elsewhere it **always** probes: spawn
  a login shell `[$SHELL||/bin/zsh, -l, -i, -c, <print LOGIN_ENV_MARKER>; env -0 && <print
  LOGIN_ENV_END>]` (retry without `-i` on non-zero exit) with PATH reset to the OS base dirs (so rc files
  compute their canonical PATH instead of layering onto whatever the launcher passed), 5s deadline, parse
  the `\0`-separated entries between the markers, then `mergePath(current, login)` — the login PATH,
  preceded by the current entries it lacks (an activated venv, `nix develop`, direnv) so a terminal
  launch keeps its explicit additions ahead. Never throws — on any failure it leaves PATH untouched.
- There is no "PATH already looks complete" short-circuit. One existed, keyed on user-dir markers, and
  `/usr/local/bin` was among them; it heads macOS `/etc/paths` and every Linux default PATH, so the probe
  never ran for Dock-launched hosts and every session lost Homebrew/bun (`command not found`, failing git
  hooks, stuck subagents). The one-time login-shell probe per app start is cheaper than guessing.

## Get right (freePort)

- Detect occupancy by **probing with a TCP connect**, not by catching a bind error: `Bun.serve` does not
  report `EADDRINUSE` for a busy `localhost` port on every platform (it can share the port via
  `SO_REUSEPORT`), so a bind-and-catch check is unreliable. A refused connection means free.
- `findFreePort` scans upward from `preferred` (predictable: `24242 → 24243 → …`) and falls back to an
  OS-assigned ephemeral port if the whole scan range is taken.
- Its answer is a snapshot: another process may bind the port before the caller does, and a later connect
  probe of an ephemeral-range port can self-connect. Callers bind promptly; tests never re-probe the result
  (that re-probe flaked under parallel package tests).

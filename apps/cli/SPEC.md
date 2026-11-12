---
id: module-cli
type: module-design
status: active
title: CLI host launcher
parent: architecture
depends-on: [module-server, module-shared]
tags: [host]
references: [module-artifact-tests]
---

## RailDesign identity and execution

RailDesign uses `io.github.bouchee.raildesign`, new state under `~/.raildesign`, the `raildesign`
CLI, and updates from `https://github.com/Bouchee/thinkrail/releases/download/desktop-updates`.
The SDK execution path belongs to the shared host. Launchers contain native startup and packaging only.
No JetBrains service, PostHog key, attribution or survey integration ships in development builds.
The fork does not import the official application's records or configuration.

## Responsibility

The retained browser launcher and standalone rollback artifact: the `raildesign` bin. It boots the engine
host in-process and opens the browser UI at its URL. It is a thin sibling of `apps/desktop`; all engine
and process-boot logic lives in `packages/server`.

## Flow and interface

Parse flags and environment, resolve web assets, then call the shared `bootHost`. Normal launch opens
that host URL unless `--no-open`. Only interactive output prints the RailDesign startup mark; every
launch retains `raildesign → <url>`. Shutdown belongs to the host. A second writer to the same data
directory is rejected by the host's ownership policy.

The executable is `raildesign`; internal workspace package names stay `@thinkrail/*`.
Options are `--port`, `--host`, `--no-open`, `--verbose`, `--version`, `--help` and one optional project
directory. `THINKRAIL_PORT`, `THINKRAIL_HOST`, `THINKRAIL_STATIC_DIR` and `THINKRAIL_LOG_LEVEL` retain
the developer configuration namespace. Telemetry flags and callbacks are removed.

`update` and `uninstall` are exit-only subcommands; neither boots the host or re-creates staged assets.
CLI install records are under `~/.config/raildesign`, caches under the OS cache root's `raildesign`,
and user application state under `~/.raildesign`. They never touch official ThinkRail installations.

## Update advisory

A compiled `stable`/`nightly` binary in the supported `<prefix>/bin/raildesign[.exe]` layout supplies `bootHost`
with one optional periodic update-notice producer; source and `dev` identities and manually placed binaries do
not expose the capability. After the host is ready it performs a bounded lookup
immediately and every six hours on the baked channel with the same GitHub rules as the installers: stable reads
`releases/latest`, while nightly selects the first `vX.Y.Z-nightly.N` tag from `releases?per_page=20`. Only a
strictly newer version produces `{ currentVersion, availableVersion, channel }` state; discovery failure and
no-update are silent. A different newer release may replace available or failed state, but successful execution
latches until host restart so the still-running old process can neither rediscover nor install another release.

The shared update surface offers **Run Update** for a compiled host and retains fixed `raildesign update`
guidance for older clients/hosts or a failed run. The action invokes this same installed binary's parameterless
update subcommand asynchronously; the browser cannot select a command, path, channel, version, or URL. Bounded
running/succeeded/failed state converges every client, and success requires the user to restart the unsupervised
host manually rather than aborting active work. Discovery and execution remain absent from
`update`/`uninstall`/help/version exits and all source/dev launches.

## Self-update (`raildesign update`)

`src/update.ts` ports the old repo's `raildesign upgrade` (renamed): it re-invokes the **published
installer** for the binary's channel — `install.sh` on macOS/Linux, `install.ps1` on Windows — so the
installer stays the single source of the download → checksum → replace → PATH logic. For an installed binary,
the running `<prefix>/bin` layout is authoritative; an explicit channel flag wins, then metadata from that same
installation, then its baked channel. A source invocation without a running binary layout may use
`~/.config/raildesign/install.json` and falls back to `stable` / `~/.local`.

- **Unix:** `curl` the script, feed it to `bash -s -- --channel … --prefix … [--version …]`.
- **Windows:** fetch `install.ps1`, write it to a temp `.ps1`, and run it through the first available
  PowerShell host (`powershell.exe`, else `pwsh.exe`) as
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <tmp> -Channel … -Version … -Prefix …`.
  `-File` (not `irm | iex`, which needs a shell to pipe through, and not `-Command`, whose quoting is a
  minefield) hands the installer's own params through argv. All three params are passed **always**,
  including `-Version latest`: install.ps1's params *default from the `THINKRAIL_*` env vars*, which the
  child would inherit, so being explicit is what makes an update deterministic for a user who has one
  set. Replacing the *running* exe works because install.ps1's `Install-RailDesignBinary` renames a locked
  `raildesign.exe` aside to `raildesign.exe.<rand>.old` (Windows refuses to *delete* a running image but
  permits *renaming* it) and drops the fresh one in; the next install sweeps the leftover.

Any Windows failure (fetch, no PowerShell host, installer non-zero) falls back to *printing* the manual
per-shell command (`windowsManualUpdateMessage`) with the releases page under it: cmd's `set "X=v" &&`
and PowerShell's `$env:X='v';` are not interchangeable. Update planning binds metadata to the running
`<prefix>/bin/raildesign[.exe]` before trusting its prefix or channel; stale/unrelated metadata cannot update a
different copy. Missing metadata falls back to that running layout, including normalized legacy Git-Bash
`/c/...` and `/cygdrive/c/...` prefixes. Prefix representability follows [[module-ci-release]] rather than an
ASCII-only path policy: Unicode and benign punctuation remain valid. A manual binary outside the representable
layout—including a directly run release asset such as `raildesign-linux-x64`—fails closed with manual guidance
rather than installing under `.local`; that preflight also withholds the host update capability. Version/channel
combinations are validated after resolution. The planning functions remain pure and unit-tested; only installer
fetch and execution touch IO.
`THINKRAIL_INSTALL_SCRIPT_URL` / `THINKRAIL_INSTALL_PS1_URL` override the installer URLs (testing /
forks). See `module-ci-release` for the installers themselves.

## Uninstall (`raildesign uninstall`)

`src/uninstall.ts` is the inverse of the installers, and only of them: it removes **the executable, the
PATH edit the installer made, `install.json`, and the binary's staging cache** — then *asks* about the
user's app state (the data dir), which is **kept by default** because it holds the workspace git
worktrees and any uncommitted work in them. pi's own state (`~/.pi`) is never touched: it is not ours.

- **Plan, then confirm, then act.** `resolveUninstallTargets` is pure (platform + home + install
  metadata + `process.execPath` → the paths); an inspection pass narrows it to what actually exists (and
  which rc files really carry the installer's block) so the printed plan is *true*; then the prompts;
  then the removals, each reported as `removed` / `kept` / `not found` / `failed` (any `failed` → exit 1).
- **Prompts** (`node:readline/promises`): the data-dir question (default *keep*), then a final confirm.
  `-y`/`--yes` skips both and `--keep-data`/`--remove-data` answers the first one non-interactively; with
  no TTY and no `--yes` the command refuses rather than guessing.
- **Which executables:** `<prefix>/bin/raildesign[.exe]` from the install metadata (else the installers'
  `~/.local` default) **plus `process.execPath` when it is itself a `raildesign` binary** — that covers a
  custom prefix whose `install.json` is gone. Nothing else is ever deleted, whatever the metadata says.
- **The PATH edit, per platform seam:** on Unix the installer's block is *self-identifying*
  (`# >>> raildesign PATH >>>` … `# <<< raildesign PATH <<<`), so `stripRcPathBlock` removes it from every
  candidate rc file that carries it (bash/zsh/`$ZDOTDIR`/`.profile`, and the fish `conf.d` file is
  deleted when nothing but the block was in it) — and refuses to touch a file whose block has no end
  marker rather than truncating it. On Windows the registry entry is *opaque* (nothing marks it as ours),
  so install.ps1 **records whether it added the entry** (`install.json`'s `path_entry_added`, sticky across
  re-installs of the same prefix — an update sees `already` precisely because an earlier run of ours added
  it) and the uninstaller removes it **only for that flag, and only for the prefix it was recorded
  against**. Being installed is not the same as having added the entry: `-NoModifyPath`, an entry that was
  already present, a failed registry write and a Git-Bash `install.sh` install all record an install
  without touching the Windows PATH, and legacy metadata predates the flag — all of those are *not ours*,
  so the PATH is left alone and the user is told which dir to check. Both sides read `/` and `\` in an entry as the same separator, so a
  user's own `C:/…/bin` entry counts as already present: install never appends a duplicate it would then
  record as its own, which the uninstaller would remove together with the user's entry. The edit itself runs
  as an embedded PowerShell script —
  the exact inverse of install.ps1's `Add-RailDesignToUserPath` (same `HKCU\Environment` handling,
  preserving the value's `REG_EXPAND_SZ` kind, comparing entries raw *and* `%VAR%`-expanded, then
  broadcasting `WM_SETTINGCHANGE`) — because round-tripping a raw PATH value through a pipe would risk
  mangling non-ASCII entries in the console code page.
- **Deleting the running program:** Unix unlinks a running binary happily. Windows cannot, so the exe is
  renamed to the same `raildesign.exe.<rand>.old` name install.ps1's cleanup already recognizes, and a
  detached PowerShell retries the delete for a few seconds after we exit; the report says which happened.
  Stale `.old`/`.new` leftovers in the bin dir are swept too.
- `src/powershell.ts` is the shared seam for both Windows paths (find a host, run a script text through
  it, `psQuote` a value into a single-quoted literal). `src/paths.ts` owns the *installed* layout —
  `install.json` (read by `update` + `uninstall`) and the staging cache root (written by
  `compiled-entry`, deleted by `uninstall`) — so those three agree by construction.

## Version stamping

`@thinkrail/shared/version` exports `{ version, channel, commit }`, with `0.0.0-dev` as source default.
CLI `--version`, desktop metadata and `server.welcome.appVersion` use this shared identity. No analytics
key or attribution flow is part of launcher startup.

## Single-file binary

The binary embeds the built web artifact and physical host resources from the server build-support
manifest. Skill content is embedded by `skill-assets.generated`, staged under its content hash, and
passed to `setBundledSkillPaths` before host startup without any extension factories. Native PTY
libraries and trash helpers remain staged assets. The launcher does not implement
an agent loop. SDK and tool assets replace legacy pi assets as their owning integration is removed.
Source-build correctness does not establish compiled-binary or installer acceptance; those have separate
stage 4 smoke gates.

## Boundary

- **Owns:** `src/args.ts` (pure `parseArgs(argv, env) → CliOptions` + `parseSubcommand` + `USAGE`),
  `src/index.ts` (the run-from-source `bootstrap()`: shell env → server → browser open → signal handlers),
  and the binary build (`scripts/build-binary.ts`,
  `scripts/artifactName.ts` — exposed as `@thinkrail/cli/artifact` and the one place the artifact filename
  rule lives, including the `.exe` Bun appends for a Windows target, so the build's output path and the
  smoke's default input cannot disagree the way they did on Windows. It also holds the Windows-target
  rule. The release action re-derives the same name in bash because it is also the published-asset
  contract, see `module-ci-release`),
  `src/compiled-entry.ts`, `src/web-assets.generated.*`, `src/skill-assets.generated.*`,
  `src/runtime-assets.generated.*`),
  `src/update.ts` (the `update`
  subcommand plus same-channel GitHub release discovery for the host advisory), `src/uninstall.ts` (the
  `uninstall` subcommand), `src/paths.ts` (the installed layout:
  `install.json` + the staging cache root), and `src/powershell.ts` (the Windows PowerShell seam). Model configuration belongs to the shared host.
- **Allowed deps:** `@thinkrail/server` (`bootHost`, `registerBundledRuntime`, build-support, `dataDir` — the
  uninstaller has to name the app state dir, and must name the *same* one the host uses),
  `@thinkrail/shared/startupMark` (the shared boot
  signature renderer) + `@thinkrail/shared/version` (the shared release identity) +
  `@thinkrail/shared/windowsIdentity` (the Windows file properties and ICO the build stamps), Bun/Node;
  the generated build module may
  value-import the bundled extension packages' entries (resolved via the server package — build-time
  only, deleted after compile).
- **Forbidden:** product feature/domain logic; reaching into the server's internals (use only its public
  surface); importing the web, desktop, or `contracts` UI layers; `@earendil-works/pi-coding-agent`
  directly; importing the artifact test workspace. Its smoke adapter and shared probes belong to
  [[module-artifact-tests]]. An ordinary product feature must not need a CLI implementation.

## Get right

- A stable default port is friendlier than `port:0` for a CLI you re-run, but you must know the resolved
  port to open the URL — so scan upward from the requested port to the first free one, then open the
  resolved origin. (`Bun.serve` won't surface `EADDRINUSE` for a busy port, so the free port is found by
  probing, not by catching a bind error — see `@thinkrail/shared/freePort`.)
- The browser is a first-class client, not a fallback — the same UI can point at a remote host.
- The agent runs in this process — a fatal fault takes the app down (the accepted in-process tradeoff).
- `resolveShellEnv()` runs once, before any `AgentSession`.
- The startup mark is a presentation of the resolved launch result, never a second readiness signal:
  `bootHost` must return first, and the parse-stable `raildesign → <url>` line remains unchanged beneath it.

## Later

A headless `serve` mode (always-on host for remote/automations). The shipped desktop sibling swaps
"open a browser" for "open a native webview" over the same `bootHost()` lifecycle.

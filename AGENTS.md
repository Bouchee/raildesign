# RailDesign

RailDesign keeps the workbench and isolated Git workspaces from ThinkRail. The host owns application
state and persistence; the OpenAI Agents SDK owns model calls, the agent loop and tool dispatch.
Use fresh RailDesign records. Do not import pi sessions, credentials or plugins.

## Read context proportionally

- Use `goal-and-requirements.md` for the product's goal, principles, capabilities, and non-goals.
- Use `architecture.md` for system topology, cross-module decisions, and repo-wide invariants.
- For SDK changes, read the official JS/TS SDK documentation and installed public types first.
  For an Electrobun upgrade, read `electrobun-compatibility.md`.
- Read the owning `SPEC.md` when work is governed by or may alter a module boundary, contract,
  invariant, documented behavior, or architecture decision.
- Localized work does not require unrelated specs or a full repository map.

## Module structure and boundaries

Clear, fractal module boundaries are a top-priority requirement:

- Every package and meaningful directory-level sub-module has a `SPEC.md` stating its responsibility,
  public surface, allowed dependencies, and forbidden reaches.
- A sub-module exposes an `index.ts` barrel as its only public surface; siblings import through the
  barrel, never internals. Per-file imports remain only where a barrel would defeat code-splitting or a
  library convention, such as `apps/web/src/panels` and `packages/ui`.
- Dependency edges between sibling sub-modules live in the parent module's `SPEC.md`, not each leaf.
- A change that moves or blurs a boundary updates the owning spec first. Cover public surfaces and
  boundary rules with tests where practical, but do not manufacture coverage for a localized change.

## Engine and architecture

- Run one SDK Agent/Runner path in-process; only one Runner may operate in a session.
- The three rings are engine host (`packages/server` + `packages/shared`), application-owned wire
  (`packages/contracts`), and independently shippable UI (`apps/web`). CLI and desktop are thin launchers.
- Keep model credentials, private provider configuration and full RunState on the host.
- Register ordinary FunctionTools over existing workspace services. Stop revokes the run grant before
  cancelling the model and owned process trees. Stale callbacks cannot restore that grant.
- Do not preserve obsolete execution paths, readers, compatibility adapters or runtime fallbacks.

## Repo-wide invariants

- `apps/web` depends on `contracts`, `locales`, `ui`, `extension-api/web`, `resource-renderers`, and
  `thinkrail-extensions/*/web` only, never `server` or `shared`.
- User-facing UI text is a key in `packages/locales/en.json` rendered through `@thinkrail/locales/react`;
  the lint gate rejects hardcoded JSX text and text attributes.
- Never bundle the server SDK or model credentials into browser assets.
- The host owns stable session, run, message, tool and interaction IDs. `session.event` has a monotonic
  sequence. Apply streamed deltas and final corrections to the same message.
- Subscribe before hydration; buffer live events until the snapshot watermark is known.
- Publish success only after full settlement with no cancellation, error or pending approval.
- UI panels are layout-agnostic; the shell arranges them.
- Keep diagnostics local through `logger(scope)`. Do not add upstream telemetry or surveys.
- The transport host endpoint is a parameter, defaulting to same-origin; `server.welcome` carries the
  protocol version.

### Web UI context

For web UI work, read `apps/web/SPEC.md` and the owning sub-module spec. Styling uses Tailwind v4
utilities mapped to generated semantic CSS-var tokens: never inline style objects, raw hex, internal
palette names, or unknown token utilities. Read `apps/web/src/styles/COLOR.md` for color work and
`apps/web/src/styles/SPACING.md` for spacing work. Use `@remixicon/react` icons (Line by default, Fill
when active) and owned shadcn/Radix primitives from `@thinkrail/ui/<primitive>`; `cn()` lives in
`@thinkrail/ui/utils`. These rules also apply to `packages/ui`, `packages/resource-renderers`, and extension
web halves.

For conversation rendering or tool presentation, read `apps/web/src/chat/SPEC.md`. Presentational
renderers remain props-driven; only `ChatView` integrates store and transport. A server capability and
its UI renderer are joined by tool name through `registerToolRenderer`; unregistered tools use the
default renderer.

## Specs and comments

Specs are the durable home for intent, decisions, invariants, trade-offs, and post-mortems. Keep them
concise and avoid restating code or another spec. Comments are near-zero: lint/type directives and a
rare one-line hazard note are acceptable; rationale and narrative belong in the owning spec.

## Verification

Local tests use disposable fixtures and have no production access. Run affected tests, fix failures
caused by the requested change, and rerun them without asking for approval at each step.

- Iterate with the smallest relevant unit or focused E2E target.
- For shipped app behavior or integration changes, run the complete no-agent browser suite
  (`bun run e2e`) once after the combined implementation and before final handoff or PR — not once per
  TODO item or commit.
- When the change touches real agent behavior, also run the focused live specs that cover it, e.g.
  `bun run e2e:agent e2e/raildesign-stage1.live.spec.ts`; that needs no approval. Ask the user before running
  the complete `bun run e2e:full` suite: it spends real provider tokens and much more time.
- Documentation/spec-only changes and test-harness-only changes use targeted checks unless they can
  affect the shipped runtime.
- Fast gates: `bun run check:deps`, `bun run check:boundaries`, `bun run check:seams`, `bun run lint`,
  and `bun run typecheck`. Unit tests are `bun run test`; `bun run check:spec-surface` validates enrolled
  spec/barrel public surfaces; `bun run check:compiler` fails when a web function newly bails out of the
  React Compiler (or starts compiling) against the committed census baseline.
- `bun run test:workflow-helpers` checks deterministic workflow helpers without a model or live acceptance.
- Binary and desktop artifact modes have separate gates; use them when changing those artifacts.

All runner modes, isolation guarantees, credential handling, cancellation behavior, and debugging
commands live in `e2e/SPEC.md`; workflow harness details live in `e2e/workflows/SPEC.md`.

## Handoff hygiene

Green gates are necessary but not sufficient:

- Before a local handoff, review the task-scoped working tree and commits. Before opening or updating a
  PR, review the full branch diff against its base plus the working tree.
- For nontrivial implementation, do a subtraction pass: remove avoidable abstractions, state owners,
  dependencies, compatibility layers, and fallbacks. Report material removals and justify layers that
  remain; do not add ceremony for a localized edit.
- Never add `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `eslint-disable`, or `as any` merely to make
  a gate pass. Treat the error as a design signal. If a suppression is genuinely required, get explicit
  user approval first.
- Audit newly added comments and suppressions in the same diff range being reviewed. Do not let prior,
  unrelated branch history contaminate a task-local handoff.
- Centralize duplicated nontrivial derivations. In the web app, derived store state belongs in
  selectors and writes that always travel together belong in one atomic action.
- When replacing a pattern or state model, search for every old occurrence and migrate it, or name the
  intentional survivors.
- `README.md` is the user-facing front page. For a change that adds, removes, or renames a user-visible
  capability, or alters installation or analytics behavior, review its claims and update the affected
  ones in the same change; refresh a screenshot under `.github/readme-assets/` when the UI it depicts
  changes materially.
- Apply safe cleanup that is inside the approved scope. Ask only for destructive, out-of-scope, or
  product-level decisions.
- Use the `shipping-a-pr` skill for PR lifecycle work, including screenshot expectations and PR
  templates. When creating an issue programmatically, reproduce the selected issue template and pass
  its frontmatter labels.

## Stack

Bun + Turbo monorepo · TypeScript strict · React 19 + Zustand + Tailwind v4 · OpenAI Agents SDK.
App state lives under `~/.raildesign`; the application identifier is `io.github.bouchee.raildesign`.

Dependencies pin exact versions. Cross-cutting dependencies are pinned once in the root
`workspaces.catalog` and referenced through `catalog:`; peer dependencies and local protocols are the
only exemptions. `architecture.md` Decision #10 owns the rationale.

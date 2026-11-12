---
id: module-extension-api
type: module-design
status: draft
title: Host extension contracts and pure renderer helpers
parent: architecture
depends-on: [module-contracts, module-locales]
references: [module-thinkrail-extensions]
---

## Responsibility

The source-only host extension contract, independent of presentation components and host state. The
browser and server descriptors compose capabilities without importing either application's internals.
The host retains registration, lifecycle and ordering; `define*` helpers preserve the supplied descriptor.

## Boundary

- `./web` exposes `ToolStatus`, `ToolRenderProps`, `ToolRenderer`, `ToolSummary`, `ToolChrome`,
  `ToolProminence`, `ToolRegistrationOptions`, `ToolInteraction`, `ToolInteractionState`,
  `ToolPlacement`, `WebExtension`, `defineWebExtension`, and the pure argument/result readers from
  `toolHelpers` and `toolResultContent`.
- **Interactive tools.** A tool whose `execute` waits for the person's response is *interactive*. The
  contract is tool-agnostic on both sides and keyed by `toolCallId`; the host learns a tool's name only
  from the two declarations below:
  - server: `ServerExtension.interactiveTools?: Record<toolName, InteractiveTool>` names the tools whose
    calls wait, so the host can repair a call left dangling by a restart (it writes the pending marker,
    not an error) and derive needs-input from a transcript it is not live on.
    `InteractiveTool.validateArgs?` validates a call before the host publishes its interaction; `parseResponse?` validates the response against the original call. Those hooks stay extension-owned.
    `InteractiveTool.describeResponse?(args, response)` returns the model-facing text for a response
    delivered **after a host restart** (the only path where the tool's own `execute` is gone); `undefined`
    or no hook ⇒ the host writes a generic preface plus the response as JSON. Live responses never pass
    through it: the tool formats its own result.
  - web: `ToolRegistrationOptions.interactive: true` asks the host to fill `ToolRenderProps.interaction`
    for that renderer; `dock: true` (meaningful only with `interactive`) also asks the chat to render a
    call the host awaits in its interaction dock above the composer rather than in the transcript. Docking
    is opt-in because only the extension knows its renderer can live in a height-capped panel.
  - **Pending marker.** A result whose `details` is `{ kind: "ack" }` on an interactive call means "the
    response is still pending": the host writes it on restart repair, and a tool returns it (with
    `terminate: true`) when `awaitToolResponse` resolves `deferred`. It is the one shape both sides read
    (`contracts`: `isToolResponsePending`); a tool must not use it for a real result.
- `ToolRenderProps.interaction` is optional. The host fills it for every renderer registered
  `interactive`. It carries:
  - `state`: a `response` (`unknown` — the response delivered outside the tool result after a host
    restart, or the final result's `details` when it is not the pending marker), plus `superseded`,
    `ended`, and `accepting` — whether the host is waiting for this call's response right now (a call the
    host is not waiting on, such as a same-name tool from another package, renders but cannot respond);
  - `respond(response)` — the value travels to the tool as is; the tool validates its shape;
  - the chat's `focusScope`, so the card claims attention focus once per chat mount;
  - `prepareLayoutChange`, which keeps the reader's place when the card changes size;
  - `focusComposer()`;
  - `placement` (`ToolPlacement`) — `"dock"` for the live copy in the chat's interaction dock, `"stub"`
    for the transcript row while that copy is docked, absent anywhere else (the plan page, a call the
    chat does not dock);
  - `hostProtocol` — the connected host's protocol version, so a renderer can withhold an affordance an
    older host would not understand (the app's `supports*` gates, handed through tool-agnostically).

  Without it, a renderer shows the call read-only from `result`, as in a subagent transcript. The
  renderer stays props-driven: it never reaches the chat's contexts, store or transport. `state` and
  `respond` are the stable contract; the focus/layout members and `placement` are the chat's own services handed
  through and may change with the chat (a renderer must tolerate their absence). Its DOM-typed members
  are the reason the package's `lib` includes `DOM`; the package still never touches the DOM.
- `WebExtension` is `{ name, toolRenderers }`, with each tool-name entry carrying a `renderer` and
  optional `ToolRegistrationOptions` under `options`. `defineWebExtension` is a typed identity helper:
  it preserves the descriptor and its inferred tool keys without registration or default injection.
- `./server` exposes `ServerExtension`, `SdkToolServices`, `ToolResponse`, `InteractiveTool` and `defineServerExtension`.
  Descriptors hold `name`, optional display copy, `sdkTools`, `sdkChildTools`, `interactiveTools`, boolean `settings` and `skillPackages`.
  Factories return SDK tools from explicit host services.
  The helper preserves the descriptor without registration or default values.
  The host supplies cwd, grant checks, saved responses, failure reporting, workspace checks and frozen settings.
  The server entry also exports `parseToolResultContent` and `ParsedToolResultContent` for host result projection.
  SDK types remain server-only and disappear from runtime imports.
- The root is browser-safe and exposes only the web contract; it never re-exports the server half.
- Workspace dependencies are `contracts` and, type-only, `@thinkrail/locales/react`'s `Translator`.
  React and the SDK are type-only contract dependencies; there are no React components, registry, DOM access,
  host imports, or SDK runtime values.
- `ToolSummary` is `(props, t) => string`: the host passes the render-time `Translator` from `useT()`
  (`getToolSummary(t, name, props)`), so a collapsed card or routine row recomputes its summary on a
  language change; a summary translates only through that `t`, never the global translator
  (`check:i18n` flags a `summary` that reads it — [[module-locales]]).

Canonical tool-result parsing remains shared by renderer text extraction and the host's common image
layer: accept only well-formed supported image blocks, preserve text-block order, and fall back to
readable values for noncanonical results. Props-driven renderers receive optional file navigation from
the host, never acquire it from a store or transport. Extension composition rules live in
[[module-thinkrail-extensions]].

## Verification

Package tests exercise descriptors through their public entries, pure argument/result helpers and
browser bundling of both the root and `./web`. Browser bundles permit only contracts at runtime and
reject React, pi, host and server imports; `./server` separately verifies that SDK types do not enter runtime bundles.
The app's registry and common-image-layer tests retain coverage of the host-owned rendering behavior.

The SDK factory receives fresh `SdkToolServices`: run-grant validation, the saved owned response,
explicit tool-failure reporting, workspace path checks and frozen per-extension settings. The host uses
public SDK interruptions for interactive calls and recreates the factories before checkpoint restoration.
The SDK import is server-only and type-only in this contract package; browser entries stay SDK-free.

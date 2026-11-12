---
id: module-thinkrail-extensions
type: module-design
status: active
title: SDK server and web extensions
parent: architecture
depends-on: [module-contracts, module-extension-api]
tags: [extensions, ui-sdk]
---

## Responsibility

Each private `@thinkrail/ext-<name>` package has independent server and web entries.
The server registers SDK tools through a static descriptor.
The web entry registers props-driven renderers by tool name.
The host owns runtime state, permissions, settings and execution.

## Server contract

The server entry exports `defineServerExtension` data with a stable name and optional display copy.
`sdkTools` returns parent tools from explicit session services.
`sdkChildTools` supplies tools only to permitted child definitions.
`interactiveTools` declares response validation and restored-response text.
Boolean settings belong to the descriptor and the host stores their values.
`skillPackages` identifies packages whose `pi.skills` declarations supply Skill roots.
There are no Pi factories or extension loaders.

The server registry records each descriptor and its public specifier.
Static imports include factories in CLI and desktop bundles.
The host snapshots enabled names and settings before execution.
Recovery recreates the same tool graph and rejects unavailable factories.
Skill resolution starts from each extension's own dependency graph.
Staged roots preserve extension ownership under `skills/extensions/<name>`.

## Web contract

The web entry exports `defineWebExtension` data and explicitly required shared components.
Renderers receive state and callbacks through public props.
They do not read transport, store or host internals.
Heavy renderers load lazily.
Localized text uses the shared locale package.
Styles use the generated semantic tokens and public UI primitives.
Resource previews use the public resource-renderer interface and host-supplied workspace scope.
The shared host dictation layer serves normal text fields without extension-specific execution.

## Composition and dependencies

The server imports only public extension server entries.
The browser imports only public extension web entries.
Within an extension, server and web directories cannot import each other.
Server entries can use the SDK, pure helper packages and extension-api server contracts.
Web entries can use UI, contracts, locales, resource-renderers and extension-api web contracts.
They can import pure helper types without an execution dependency.

## Current members

- `visualize` supplies one SDK visualization tool and strict server Mermaid validation.
- `ask-user-question` supplies SDK interruption and validated saved-response execution with a docked questionnaire renderer.
- `web-access` supplies DeepSeek Search and Fetch through injected host services and existing app-local web cards.

Keep tool names and result shapes consistent across each server and renderer change.
Remove the old execution path when its SDK replacement works.
Do not add compatibility factories or another execution engine.

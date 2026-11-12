---
id: submodule-server-extensions
type: submodule-design
status: active
title: SDK extension registry
parent: module-server
depends-on: [module-extension-api, module-thinkrail-extensions]
tags: [extensions, public-surface-checked]
---

## Responsibility

Compose the server extensions from one static registry.
The host owns sessions, grants, interactions and settings.
Extensions receive session services and return public SDK tools.
They do not create an execution engine.

- **Public surface (barrel):** `serverExtensions`, `ServerExtensionEntry`, `listExtensionCatalog`, `snapshotSdkExtensions`, `registrySdkTools`, `SdkExtensionSnapshot`, `SdkExtensionKind`, `interactiveTools`, `InteractiveTools`, `ExtensionDisabled`, `SdkToolServices`, `InteractiveTool`, `ToolResponse`, `checkWorkspaceFile`, `workspaceFiles`, `MOCKUP_DIR`, `resolveExtensionSkillRoots`, `extensionSkillRoots`, `STAGED_HOST_SKILLS_ROUTE`, `stagedExtensionSkillRoute`.

## SDK composition

`registry.ts` imports each public extension server entry and records its specifier.
Static imports include the factories in CLI and desktop bundles.
`snapshotSdkExtensions` saves enabled factory names and resolved boolean settings.
Its `kind` selects parent or child factories.
`registrySdkTools` creates fresh tools from that snapshot and the matching factory kind.
Missing factories or undeclared settings produce explicit errors.
Recovery never substitutes another graph.

## Catalog and interactions

The Settings catalog reads parent tool names from SDK factories with inert services.
It never executes tools or child factories.
Declared setting defaults apply to catalog construction.
The existing `hasChildExtensions` wire field identifies an SDK child factory.

`interactiveTools` collects enabled extension declarations by tool name.
The first declaration wins a collision.
The agent uses these declarations for response validation and recovery.
It does not import extension implementations outside the registry.

## Skills and workspace files

Skill resolution starts from the extension's own public specifier.
Each `skillPackages` manifest declares its roots in `pi.skills`.
Missing Skill roots produce explicit errors.
Source mode uses these roots directly.
Staged mode uses `skills/extensions/<name>` and the host uses `skills/host`.
A disabled extension contributes no Skill roots.

Workspace preview paths must be relative regular files within the session worktree.
Checks reject `.git`, missing files and symbolic-link escapes.
The extension contract remains independent from the implementation of these checks.

## Dependencies

Allow extension server entries, extension-api server contracts, application contracts and Node built-ins.
Do not import host handlers or settings state.
The caller supplies current session services and snapshots.

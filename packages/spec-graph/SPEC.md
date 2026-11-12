---
id: module-spec-graph
type: module-design
status: active
title: Project specification model and SDK tools
parent: architecture
depends-on: [module-shared]
tags: [spec-graph, agents-sdk]
---

## Responsibility

`@thinkrail/spec-graph` supplies the specification model, eight SDK tools and the Spec Skill.
A file is a Spec when its frontmatter contains nonempty `id` and `type` fields.
The host owns SDK execution and UI.
The package has no Pi registration or execution path.

## Public surface

The root exports `createSpecTools`, `SpecToolServices` and `SPEC_RULE`.
The `./core` entry exports the independent read model and ranked section search.
The package manifest declares its Skill roots through `skills`.
`tools/` remains internal to the package.

The host supplies the active worktree and run-grant check.
Tool factories let SDK validation and execution failures propagate to the host invocation boundary, which records structured error results.
Repository sessions and their children receive the Spec tools and rule.
A child with an explicit tool list receives only the Spec tools in that list.
Standalone chats and their children do not receive them.

## Model and changes

The filesystem is the source of truth.
The index is a derived read cache.
It scans paths in name order and ignores generated, dependency and assistant scratch directories.
It checks each file's modification time and size on every read.
Changed or new files are parsed again.
Missing files leave the index.
The graph changes only when the Spec set changes.

One `SpecIndex` serves each root.
An edit within the same modification-time tick with the same byte size can escape that cache check.
A content hash is the next required change if this limit becomes material.

`spec_create` writes canonical frontmatter order and heading stubs selected by type.
`spec_update` edits frontmatter only.
It preserves comments, nested fields, field order, line endings and every body byte.
No tool edits Spec prose.

## Tools and knowledge

Read tools are `spec_search`, `spec_grep`, `spec_get` and `spec_graph`.
Write and validation tools are `spec_create`, `spec_update`, `spec_delete` and `spec_validate`.
The Skill gives the schema, concepts and workflow.
`SPEC_RULE` tells the model when a documented boundary or decision requires a Spec lookup.
Localized work does not require unrelated Specs.
The host adds this rule to SDK instructions.

## Dependencies and checks

Allow the public SDK, TypeBox, shared output helpers, YAML and Node built-ins.
The core has no SDK or host dependency.
Tools access the core through its barrel.
Do not import server or UI internals.
Tests cover live filesystem changes, frontmatter preservation, path checks, output limits and SDK invocation.

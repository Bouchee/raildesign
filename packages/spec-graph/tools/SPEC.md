---
id: submodule-spec-graph-tools
type: submodule-design
status: active
title: SDK specification tools
parent: module-spec-graph
depends-on: [submodule-spec-graph-core, module-shared]
tags: [spec-graph, agents-sdk]
---

## Responsibility and public surface

The barrel exports `createSpecTools` and `SpecToolServices`.
Each tool checks the supplied run grant and validates raw arguments with TypeBox.
Services provide `cwd` and `assertActive`.
The tools use the core barrel and return text with structured details.
The create, update and delete tools require approval.
The other five tools are read-only.
Leaves do not import each other.

## Output and search

Text and notices stay within 2,000 lines and 50 KiB.
Oversized responses use owner-only temporary files.
Capture failure is explicit and cannot invalidate a completed mutation.
Errors retain `isError` and a visible error message.
SDK error fallbacks mark the call as failed and return the bounded error text.
Structured details supply presentation data to the host.

`spec_grep` pages by match offset with count and byte limits.
Continuation retains the same filters.
Offsets address current sorted source files, so a source change requires a new search.
An oversized match is captured rather than skipped or split.

`spec_search` updates its section index from the current Spec index on every call.
Only changed files need new tokens.
The section-index cache retains the four most recently searched roots.
Results identify path, line, Spec, heading and snippet without complete section bodies.
The default result limit is 8 and the maximum is 25.
Type, tag and parent filters apply.

## Write rules

`spec_create` validates its path through `resolveSpecPath`.
The output must parse as a Spec before the write.
An exclusive write rejects a race or an existing link.
Reported paths use the core's canonical relative path.

`spec_update` cannot remove or blank `id` or `type`.
It cannot rename `id`.
It changes scalar fields through `set` and list fields through `addList` or `removeList`.
The core edit preserves comments, unknown fields, field order, line endings and body bytes.

Field names come from `FIELDS`.
Finite schemas derive from `SPEC_TYPES`, `SPEC_STATUSES`, `SLICE_DIRECTIONS` and `LINK_KINDS`.
The root comes from the supplied services.
Read tools share one `SpecIndex` for each root.
The next read observes completed writes through the core cache rules.

## Dependencies

Allow the core barrel, SDK tools, TypeBox, shared output helpers and Node built-ins.
Do not import core leaf files, server internals or UI code.
Project writes belong to the three write tools.
Response capture uses only private temporary files.

---
id: submodule-server-history
type: submodule-design
status: active
title: history — chat-history search index
parent: module-server
depends-on: [module-contracts]
tags: [history]
---

## Responsibility

Incremental prompt and transcript search over RailDesign's own JSON session records. The index is a
search projection; the agent module owns execution and canonical session persistence.

## Boundary

- **Owns:** `extractSession`, `HistoryIndex`, `getHistoryIndex`, scope-filtered prompt/message hits and
  the sanctioned `history-test-fixtures` writer used by browser tests.
- **Consumes:** application-owned transcript types, search limits and guards; the persistence data
  directory; Node filesystem operations. No SDK runtime object reaches the browser.
- **Forbidden:** pi formats, migration/import, upstream state, credentials and agent execution.

## Storage and indexing

Read flat `<dataDir>/sessions/<sessionId>.json` records with `version: 2`, sessionId, cwd, optional title
and messages. Each transcript message has a stable ID. Extract only user/assistant text, skip control
prompts and preserve indices from the renderable transcript, including non-text/tool rows. Host-only
model history, checkpoints and credentials are never returned by this projection.

The default discovery root is the RailDesign persistence directory. Tests can supply an explicit
session directory. Read direct `.json` files only; nested directories and legacy JSONL are not indexed.
Malformed and other-version records are excluded without rewriting them. No older schema is imported.
Track mtime and size, revalidate every two seconds, drop removed files,
and bound a cold request's wait to 150 ms. Search retains scope filtering, AND matching, recency order,
normalized prompt de-duplication, snippet and result limits.

## Fixtures and checks

`writeFixtureSession(dir, options)` writes the same versioned JSON shape with deterministic message IDs,
explicit workspace metadata and display transcript, never pi records. `sessionDirFor(dataDirectory)`
returns the flat directory; callers pass the actual workspace ID when attaching through the UI.
Renderer fixtures may explicitly supply a complete `SessionState` and application-owned custom or
summary transcript messages. They never append legacy JSONL entries to a JSON record or infer a live run.
An explicit `updatedAt` fixture option sets session activity metadata even for an empty transcript;
session ordering does not use a fixture file's mtime.
Tests cover extraction/schema rejection, stable IDs, index alignment, bounded and scoped search,
incremental reload/removal, empty-query behavior and fixture round trips.

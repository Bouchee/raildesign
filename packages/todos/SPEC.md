---
id: module-pi-todos
type: module-design
status: active
title: Conversation Plan tools and store
parent: architecture
depends-on: [module-shared]
references: [module-spec-graph, submodule-web-chat]
tags: [agents-sdk, todos]
---

## Responsibility

`@thinkrail/todos` supplies conversation Plan tools, the Plan store and the todos Skill.
The host owns SDK execution and application UI.
The package has no Pi registration or runtime.

## Public surface

The root exports `createTodoTools`, `TodoToolServices` and `TODO_RULE`.
The `./core` entry exports Plan types, status tuples, `TodoStore`, `groupStatus` and related pure helpers.
The package manifest declares its Skill roots through `skills`.

`createTodoTools({ cwd, sessionId, assertActive })` returns seven SDK FunctionTools.
The host supplies the active conversation identity and grant check.
Tool factories let SDK validation and execution failures propagate to the host invocation boundary, which records structured error results.
`TODO_RULE` gives the threshold for Plan creation and points to the todos Skill.
A request with at least three substantive execution steps normally needs a Plan.
Explicit user requests for a Plan also apply.
An existing loose item needs promotion when the agent starts its work, regardless of that threshold.

## Plan ownership

A group represents one user task.
Its title describes the outcome.
Its items are ordered execution steps.
Group status is derived from item status, never stored separately.
Only one item can have status `in_progress` across the complete Plan.
Starting another item returns the previous item to `pending` and reports that change.

The loose queue contains raw user or agent input.
`todo_promote` atomically changes a loose item into its own group with the same ID.
It preserves the title unless the caller supplies an override.
An empty promoted group is valid until the agent adds its first step.
The tool rejects title collisions and cannot silently merge user tasks.
`todo_add` can add loose input or a grouped step.
An `after` anchor must name a grouped step.

## Persistence and changes

Each conversation has one file under `.raildesign/context/todos/<sessionId>.json`.
`TodoStore` reads the file before each operation.
Agent tools and user edits therefore share the same current data.
Missing or corrupt data reads as an empty Plan.
The core validates session IDs and sanitizes stored fields.
The current file version is 6.

The agent owns status changes.
The UI currently adds or removes user items.
Origin records whether an item came from the agent or user.
`todo_write` reconciles groups by group title and step title.
Matching steps retain identity, status, completion data and artifacts.
Only their notes can change through this reconcile operation.
Omitted open agent steps can disappear.
Loose items and completed items remain.
Duplicate titles match in order.
A renamed title represents a new step.

## Completion and artifacts

`todo_update` records item summary, verification and commit subject.
Leaving `done` clears stale item completion data.
`todo_plan_summary` records the complete Plan summary.
A later completion extends an existing summary instead of reducing it to the latest step.
The UI displays the summary when all items are complete.
The summary uses `## Summary`, `## Changes` and `## Testing` for PR output.

The agent attaches file and Spec artifacts.
The host attaches change and commit artifacts.
The core and tools do not execute Git operations.
Host artifact hooks observe SDK tool completion and retain their existing ownership.

## Dependencies and checks

Allow public SDK tools, TypeBox, shared output helpers and Node built-ins.
The core uses Node built-ins only.
Do not import server or UI internals.
Core tests cover persistence, isolation, reconciliation, promotion and completion data.
Tool tests use public SDK invocation with real temporary stores and grant checks.

---
id: submodule-pi-todos-tools
type: submodule-design
status: active
title: SDK Plan tools
parent: module-pi-todos
depends-on: [submodule-pi-todos-core, module-shared]
tags: [agents-sdk, todos]
---

## Responsibility

Expose `todo_list`, `todo_add`, `todo_update`, `todo_promote`, `todo_remove`, `todo_write` and `todo_plan_summary` as SDK FunctionTools.
Each leaf uses the core barrel and the shared result helpers.
The tools do not create sessions or perform Git operations.

## Public surface

The barrel exports `createTodoTools` and `TodoToolServices`.
Services provide `cwd`, `sessionId`, `assertActive` and `markToolFailed`.
Each invocation checks the run grant before store access.
TypeBox validates raw SDK arguments at the tool boundary.
Status schemas derive from the core tuples.

## Plan rules

`todo_write` accepts groups only and preserves the loose queue.
`todo_add` rejects a loose `after` anchor.
`todo_promote` is the atomic path from a loose item to a group.
Completed and matching items retain their identity during Plan reconciliation.

Tool results report automatically paused items and suggest the next open step.
A suggestion does not start that step.
When the final open item completes, the result requests the complete Plan summary.
An existing summary appears in that request so the agent can extend it.
Summary and verification fields accept Markdown.
Commit subjects follow the project's own commit style.

## Output limits

Text and notices stay within 2,000 lines and 50 KiB.
The shared output helper preserves complete UTF-8 lines.
Oversized output goes to an owner-only temporary file.
The response identifies that file and its temporary lifetime.
Capture failure is explicit and does not undo a successful mutation.
Errors retain `isError` and a visible error message.
SDK error fallbacks mark the call as failed and return the bounded error text.
Structured details supply presentation data to the host.

`todo_list` returns the full Plan when it fits.
A larger Plan uses a rendered-line offset with the same status filter.
The page budget reserves space for notices.
One oversized line remains available in the captured file and advances the offset by one.
Offsets refer to current data, so the caller must restart after Plan changes.
There is no configurable page size.

## Dependencies

Allow the core barrel, public SDK tools, TypeBox, shared output helpers and Node built-ins.
Only `TodoStore` owns project Plan persistence.
Temporary output capture does not change that ownership.

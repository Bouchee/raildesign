---
id: submodule-server-agent-background-commands
type: submodule-design
status: active
title: Session-owned background commands
parent: submodule-server-agent
depends-on: [submodule-server-subprocess, module-contracts]
tags: [background-commands, public-surface-checked]
---

## Responsibility

Run explicit, noninteractive background commands for one immutable session.
Retain the existing service admission, output, cancellation and completion rules.
SDK tool registration belongs to the agent manager.
This module contains no Pi extension or configuration reader.

## Boundary

- **Public surface:** `createBackgroundCommands`, `tail`, `BackgroundCommandCompletion`, `BackgroundCommandCompletionBinding`, `BackgroundCommandContext`, `BackgroundCommandFlush`, `BackgroundCommandHandle`, `BackgroundCommandOutput`, `BackgroundCommandSnapshot`, `BackgroundCommandStart`, `BackgroundCommandStatus`, `BackgroundCommands`, `BackgroundCommandsBinding`, `BackgroundCommandsOptions`, `CommandOperations`.
- **Allowed dependencies:** contracts types, the subprocess barrel and existing agent key/environment helpers.
- **Forbidden:** host imports, PTY creation, Pi runtime APIs, arbitrary PID control and a second process executor.

The subprocess owner supplies supervised execution and process-tree termination.
The service owns each command's timeout and AbortController.
Environment construction excludes model keys and secret variables.
Current session markers use the `RAILDESIGN_` prefix.
Do not read Pi settings or add Pi paths to `PATH`.

## Resource behavior

Admit at most eight active commands per session.
Retain the newest twenty terminal records.
Active and stopping commands cannot be evicted.
Keep the latest 2,000 lines or 50 KiB of output, whichever limit applies first.
Decode split UTF-8 bytes without partial characters.
Limit error text to 4 KiB.
Retain failed launch records for inspection.

Only executor settlement establishes terminal status.
Stop is idempotent and targets the owned command handle.
Disposal closes admission before it signals all active commands.
The default disposal wait limit is five seconds.
Timeout expiry does not create a false terminal result.
No stored PID can restore execution authority after restart.

Completion claims stay with retained records.
Binding replacement cannot duplicate a delivered completion.
Failed delivery retains the pending claim.
An output read by the model can claim a finished completion.
UI output reads do not claim completion.
The manager owns safe-boundary publication and parent Stop policy.

## Checks

Retain lifecycle, output-limit, UTF-8, eviction and completion-race tests.
Test real stdout, stderr, exit status, launch failure and timeout.
Test Stop with a real descendant process.
Test secret removal and current session markers.

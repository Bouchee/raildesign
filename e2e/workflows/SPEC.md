---
id: module-workflow-tests
type: module-design
status: active
title: e2e/workflows — deterministic workflow test helpers
parent: architecture
references: [submodule-server-agent, module-server]
tags: [testing, workflow-system]
---

## Scope / trigger

Stage 1 retains deterministic helpers for checking event logs, tool/skill discipline, files, YAML spec
metadata, budgets and structured model replies. The old pi headless scenario runner, question mailbox,
credential-copying environment and JSONL transcript presets are retired. They are not SDK acceptance.

## Signatures

Specs import through `harness/index.ts`. It exposes `EventLog`, captured tool events, signal watchers,
checks, budget helpers, reply parsers, artifact presets, Markdown masking and throwaway workspace
helpers. The installed SDK owns one-shot model calls used by optional diagnostic helpers; the unit
suite only tests their pure parsing and decision logic.

## Contracts

`EventLog` consumes application `SessionEvent` records. A completed user turn is `agent_settled`.
Tool starts/ends share their call ID. Deterministic checks decide pass/fail; model-based suggestions,
user simulation and rubric diagnostics never establish a passing result. Masked fixture Markdown
cannot enter repository spec discovery. Artifact copying excludes `.git`, keeping `.gitignore` and
`.github`.

## Validation and errors

Malformed structured replies return the existing rejected/unclear result. Missing stop signals or
budget violations cannot be recorded as success. No helper copies another agent's credentials, opens
pi sessions or restores an old session factory. File/worktree fixtures remain disposable and isolated.

## Good / base / bad cases

Pure unit cases can compare skill-read order and reject an invalid questionnaire option without a
provider. A missing/invalid model reply is not evidence that a workflow passed. A historical pi JSONL
fixture cannot seed a RailDesign session.

## Tests required

`harness.unit.spec.ts` retains event capture/query, signal ordering, pure questionnaire choices/parsing,
watchdog budgets, judge/user-simulation parsing, snapshot masking and file/spec checks. It does not
exercise a model, advanced tool registration or session recovery.

## Wrong / correct

Use the isolated stage-1 browser/SDK scenario for production workflow acceptance. Do not resurrect
`respondToTool`, `SessionManager`, pi-auth copying or a fake-success runtime adapter just to compile an
old harness. Stage 2 must add SDK session/summary acceptance; stage 3 must add SDK Skills/Plan/questions
and their live workflow cases before those functions become available.

Retired live scope: workflow routing/importing/smoke scenarios, Skill-search and Skill/Todo compaction
scenarios and their shared JSONL reader. Their original implementations remain in Git history.

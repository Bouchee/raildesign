---
id: module-thinkrail-workflow
type: module-design
status: active
title: Workflow instructions and Skills
parent: architecture
depends-on: [module-spec-graph]
tags: [workflow, skill, workflow-system]
references: [module-workflow-tests, module-pi-ask-user-question, module-ext-ask-user-question]
---

## Responsibility

`@thinkrail/workflow` supplies `WORKFLOW_RULE` and the workflow Skill family.
It has no runtime engine or tool registration.
The host adds the rule to SDK instructions and discovers the declared Skill roots.

The rule routes new onboarding, PR lifecycle work and product changes to `choosing-a-workflow`.
Work that changes no behavior can proceed directly.
Direct questions about source files and fully specified local mechanical edits inspect the relevant
files without Spec or Todo tools when no Spec, TODO/Plan, or documented architecture/contract work is
involved. This condition applies to both kinds of direct work; governing-document reads, existing
loose-item promotion and applicable Plan obligations still follow their owning rules.
Existing work resumes its selected workflow.
If its Skill body leaves the context, the agent reads that Skill again before the next step.

## Skill ownership

The family table in [[submodule-workflow-skills]] is the authoritative Skill list.
Each workflow owns its instructions in one Skill.
The root router owns routing rules.
This package does not duplicate those instructions in an execution system.
New Skills use `skills/<name>/`.

Skills call product tools by name and do not import host internals.
The user-question Skill can ask through chat when the question tool is unavailable.
The authoring Skill ships with the rest of the family.
It can change the family only when `packages/workflow` exists in the current workspace.
Staged application Skills remain read-only.

## Public surface and dependencies

The root exports `WORKFLOW_RULE`.
The package manifest declares `skills: ["./skills"]`.
There are no runtime dependencies.
The host owns Skill admission, enable policy and command resolution.
The Welcome control's `/skill:setting-up-a-project` uses that same path.

## Checks and limits

Tests retain the workflow instruction export and the existing GitHub workflow contracts.
The workflow-test harness owns deeper Skill behavior checks.
Its observation matrix must identify tests that have not run on the SDK.
Source presence does not prove live workflow execution.
This package does not add ticket systems, boards or a second workflow runtime.

---
id: goal-and-requirements
type: goal-and-requirements
status: active
title: RailDesign — product goal and scope
covers: [product-goal, product-audience, product-principles, product-capabilities, product-non-goals, engine-decision]
tags: [product, scope]
---

## Goal

RailDesign is an agent workbench built from ThinkRail's editor, Diff, terminal and Git workspace UI.
Users give an agent a task in a selected worktree, inspect its actual changes and test output, approve
operations when required, and stop execution when needed.

The shared host owns application state and persistence. The OpenAI Agents SDK owns model calls, the
agent loop and tool dispatch. Desktop and browser launchers use that same host.

## Principles

- Deliver working stages. Each stage has observable acceptance checks before the next begins.
- Keep work isolated in real Git worktrees. Working in the original project folder is explicit.
- Keep the workbench, navigation, Monaco, file tree, Diff, terminal, themes and localization.
- Reuse host services and current dependencies. Remove obsolete paths without compatibility layers.
- Keep model keys and private configuration on the host. Use verified Responses-compatible models.
- Record execution evidence. A model saying it succeeded is not proof of a file edit or test result.
- Maintain module SPECs before changing their boundaries.

## Stage 1 capability boundary

The first SDK workflow changes files in the selected worktree, executes commands, streams its output,
shows the actual Diff and supports Stop plus basic tool approval. Project/worktree creation, opening,
switching, Git/PR operations, editor and terminal services remain part of the workbench.

Continuous sessions, durable interaction recovery, queues, steering and summary compaction are stage 2.
Skills, Plan, Spec Graph, MCP, background commands and subagents are stage 3. Their controls remain
unavailable until their execution works. Desktop platform artifacts and updates require stage 4 checks;
private browser/server deployment requires stage 5 checks.

## Product identity and data

The product is RailDesign, identifier `io.github.bouchee.raildesign`, CLI `raildesign`.
Fresh application records live under `~/.raildesign`; installers use independent metadata and caches.
The application never imports pi sessions, credentials or plugins, or official ThinkRail data.
Fork releases and updates come only from `Bouchee/thinkrail`.

JetBrains services, telemetry, attribution and surveys are removed. SDK tracing starts disabled.
The interface keeps its bundled fonts and themes; font family names are not service integrations.

## Non-goals

Personal accounts, per-user projects or credentials, RBAC, multi-tenant scheduling, new mechanical design
functions and cloud orchestration are outside this development plan. A later private server is one
shared instance for one person or a trusted team.

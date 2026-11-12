---
id: module-ext-web-access
type: module-design
status: active
title: DeepSeek web access extension
parent: module-thinkrail-extensions
depends-on: [module-extension-api]
references: [submodule-server-extensions, submodule-server-agent, submodule-web-chat-tools-web]
---

## Responsibility

Expose DeepSeek Search and Fetch as ordinary SDK FunctionTools.
The tool names are `web_search` and `web_fetch`.
The descriptor supplies the same tools to parents and explicitly permitted child agents.
It contains no Pi loader, provider fallback or third-party Skill package.

## Boundary

The extension imports public SDK tools, Zod and extension-api server contracts.
It receives `webAccess.search` and `webAccess.fetch` callbacks through session services.
It does not read keys, connect to providers during construction or import host internals.
The host owns protected configuration, requests, limits and cancellation.

Each tool checks the active run before and after the host call.
It passes the SDK cancellation signal to the host.
Errors mark the owning tool call as failed.
Search accepts one query and at most ten results.
Fetch accepts one page URL.

The app-local web cards render the results by tool name.
The result text contains bounded readable content.
Details identify the provider and bounded result metadata.
The host separates presentation details from model-visible text.

## Checks

Factory tests exercise actual SDK invocation with injected host services.
Service tests cover keys, API routes, validation, byte limits, errors and cancellation.
Product acceptance also requires live API execution and visible results.

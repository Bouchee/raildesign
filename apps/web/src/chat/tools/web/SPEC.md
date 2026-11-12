---
id: submodule-web-chat-tools-web
type: submodule-design
status: active
title: Search and Fetch tool renderers
parent: submodule-web-chat-tools
depends-on: [module-contracts]
tags: [chat, web-tools]
references: [module-ext-web-access]
---

## Responsibility

Render `web_search` with `WebSearchCard` and `web_fetch` with `WebFetchCard`.
The registry joins server tools and cards by those names.
The parent imports the side-effect registration file.
There is no stored-content tool or obsolete provider registration.

## Display and boundary

Search headers show the query and optional provider.
Fetch headers show the requested page URL.
Both cards display bounded text through the shared folded Markdown body.
HTTP(S) links open in a safe new tab.
A malformed local-path argument uses the existing workspace file gate.
Foreign absolute paths remain inert.
Errors display plain text.

Renderers read result data defensively and do not require optional metadata.
They use public extension helpers, chat primitives, locale text and semantic style tokens.
They do not import provider, SDK, host, store or transport code.
Tests cover headers, safe links, path gates and Markdown content.

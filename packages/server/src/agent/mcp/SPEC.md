---
id: submodule-server-agent-mcp
type: submodule-design
status: active
title: MCP configuration, trust, OAuth and SDK connections
parent: submodule-server-agent
depends-on: [module-contracts]
tags: [mcp]
---

## Responsibility

Preserve MCP configuration validation, atomic editing, project trust fingerprints, tool grants,
redacted status/log/result summaries, sign-in ownership and OAuth. These application services remain
available during the SDK migration; delayed model-tool integration does not authorize deleting them.

The global configuration is `<dataDir>/mcp.json`; explicit workspace configuration is
`<worktree>/.raildesign/mcp.json`. No pi configuration, session or credential reader is retained.
`loadMcpConfigFiles` keeps its existing `agentDir` argument name for the caller's explicit owned root.
Project entries require matching per-entry trust. Persistent tool grants remain bound to the command/
argument or URL target. Writes preserve unknown fields and file permissions and reject unsafe project
symlinks. Status and log summaries retain their existing secret redaction and output bounds.

## SDK connection boundary

HTTP connections use the pinned OpenAI Agents SDK public `MCPServerStreamableHttp`. Stdio implements
the SDK's public `MCPServer` interface over the official MCP `Client` and `StdioClientTransport`:
SDK 0.21's stdio class exposes no stderr option, while the official transport exposes `stderr: "pipe"`.
This retains bounded (64 KiB per connection), redacted process diagnostics in the owned MCP log without
reading SDK private fields. The official client owns protocol parsing, pagination and request cancellation.
The adapter preserves full call result metadata and checks actual transport child exit on close.
The public transport has no `detached`/process-group option; this gate covers its direct subprocess.
Descendant cleanup, including common `npx` launcher chains, requires explicit Stage-3 resource testing;
the command tools' existing `runBounded` process-group behavior is separate and remains in its owner.
The official MCP client's OAuth implementation owns discovery, PKCE and token protocol processing;
the application owns protected storage, authorization URL delivery, callback state and client ownership.
Connection and sign-in teardown must finish before resources or locks are released. No pi extension
factory, provider login, model request or alternate agent loop is used for MCP management.

The management/configuration APIs are real services and are covered independently of attaching MCP
tools to a model. Full SDK tool exposure and child/background execution integration remain the explicit
later-stage work; retained code and tests are the starting implementation, not a reference to Git history.

## Public surface

The module barrel exposes configuration/load/writer/management functions, trust fingerprints and policy,
redaction/status/result/log summaries, sign-in locking, the SDK connection engine and owned OAuth provider.
Sibling modules import this barrel. The host supplies workspace and session ownership; this module does
not import the host or projects.

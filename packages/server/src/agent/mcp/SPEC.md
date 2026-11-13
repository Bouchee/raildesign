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

HTTP connections use the pinned SDK's public `MCPServerStreamableHttp`.
Stdio implements the public `MCPServer` interface through the official MCP Client.
An application-owned `Transport` uses the SDK's public `ReadBuffer` and `serializeMessage` helpers.
The shared subprocess `spawnPiped` function owns its pipes and process tree.
Close kills the owned process tree while its direct process is alive, then waits for direct exit.
Drain buffered stdout and stderr for at most the shared 250 ms grace, then cancel their readers.
An exited process must not be signalled through its reusable PID. A descendant that escaped the
owned process group cannot hold the transport open through inherited pipes.
Bounded redacted stderr remains available in the MCP log.
The official client owns protocol validation, pagination and request cancellation.
The adapter retains full result metadata.
No SDK private field is read.
The official MCP client's OAuth implementation owns discovery, PKCE and token protocol processing;
the application owns protected storage, authorization URL delivery, callback state and client ownership.
Connection and sign-in teardown must finish before resources or locks are released. No pi extension
factory, provider login, model request or alternate agent loop is used for MCP management.

Management and model execution share these services.
Local fixture tests cover tool execution and cleanup.
Stage 3 still requires complete-workflow live and UI acceptance.

## Public surface

The module barrel exposes configuration/load/writer/management functions, trust fingerprints and policy,
redaction/status/result/log summaries, sign-in locking, the SDK connection engine and owned OAuth provider.
Sibling modules import this barrel. The host supplies workspace and session ownership; this module does
not import the host or projects.

## Model tools and consent

`sessionMcpTools` uses the existing session connection owner.
The SDK converts MCP schemas through public `mcpToFunctionTool`.
The application supplies invocation checks, bounded results and the complete output store.
Each call checks its run grant, workspace, connection identity and complete configuration fingerprint.
A changed or disabled server cannot execute through a captured tool.

Direct tools start enabled.
The ordinary function tool `tool_search` enables matching deferred tools for the next model step.
Hidden tools remain absent.
Completed search receipts restore deferred tool names after restart.
Current configuration and consent still control each call.
This function uses ordinary function calling, not the SDK's native tool-search wire type.

SDK interruptions retain the four existing consent choices.
`sessionMcpApproval` supplies the choice list.
`applySessionMcpApproval` checks the current binding before it applies the selection.
The host persists project grants through `setMcpToolGrantWriter`.
Chat grants use server, tool and complete configuration fingerprint.
Stop closes owned connections and their process trees. It retains the same chat consent owner and
disabled-server set for reconnect. True disposal clears in-memory chat policy.
After host restart, restore chat consent only from approved durable decisions whose tool identity and
configuration fingerprint still match. Once-only choices never become chat grants.
Persistent grants remain bound to the actual command target or URL.
The manager owns interaction IDs, revisions, receipts and SDK continuation.

Model and browser results retain bounded text and `details.thinkrail` summaries.
The text preview retains a byte prefix, including an oversized first line. Streaming UTF-8 decoding
omits an incomplete final character. Plan and Spec tools keep their separate complete-line policy.
Complete results stay in the owned output store.
No keys or raw stderr enter browser results. Remote call errors are redacted and bounded by the same
UTF-8 byte budget. Search invocation wraps public SDK validation so revoked bindings and invalid
arguments both mark the original call as failed, even when SDK error callbacks omit call details.

`list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` are ordinary SDK
FunctionTools over those same admitted connections. The public `MCPServerWithResources` interface
provides HTTP resource calls; the owned stdio adapter implements it through the existing official
client. No private SDK transport or second connection is used. Resources are read-only and do not
request write consent. Run grants, server visibility, current trust and full fingerprints still apply
before and after every request. Aborting a resource request closes its owned connection because the
pinned SDK resource methods do not accept a per-request signal.

With a server, listings return one page and its cursor. Without a server they aggregate up to 64 pages
per visible connected server and report bounded per-server failures. A cursor requires a server.
Hidden servers and MCP App UI resources are excluded. Deferred resource tools use the same ordinary
`tool_search` exposure and persisted search receipts as other MCP tools. Read results retain text and
binary content in the owned complete-output store; the model/browser projection remains bounded.

---
name: managing-mcp-servers
description: Use when the user asks to add, change, remove, enable or disable an MCP server, or when an MCP tool is missing, needs sign-in, fails, or was blocked.
---

# Managing MCP servers in RailDesign

RailDesign connects MCP tools through the OpenAI Agents SDK. Use **Settings › MCP servers** to
configure personal servers, approve repository servers and sign in. Repository configuration can
also be edited within the worktree.

## Where servers are configured

- **User level** — `mcp.json` in RailDesign's data directory, normally `~/.raildesign/mcp.json`:
  available in every project. A custom `THINKRAIL_DATA_DIR` changes this directory.
- **This repository** — `.raildesign/mcp.json` in the worktree, tracked in git. A server defined here does not
  run until the user approves it in Settings, and any later change to its entry needs approval again.
  It only loads when the user trusts the project.

Both files use this format:

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp" },
    "browser": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.83"] }
  }
}
```

- Pin package versions in `args`; never `@latest`.
- Never write a secret into either file. Reference it as `${ENV_VAR}` (from the host's environment) or
  `!command` (the command's output, for example `!gh auth token`), or let the user sign in.
- `exposure`: `deferred` (the default here — load the server's tools with `tool_search` first),
  `direct` (a few always-useful tools), or `hidden`. `codemode` is treated as `deferred`.
- Prefer Settings for personal servers; only put a server in `.raildesign/mcp.json` when the user
  wants it shared with the repository.

## GitHub

GitHub is a recipe, not a preset: its hosted server, authenticated with the user's GitHub CLI sign-in.
Add it to the user-level file (Settings › MCP servers offers the same entry under Paste JSON):

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/readonly",
      "headers": { "Authorization": "!t=$(gh auth token) && echo \"Bearer $t\"" }
    }
  }
}
```

- `/readonly` is GitHub's documented read-only mode (same as an `X-MCP-Readonly: true` header). Use
  `https://api.githubcopilot.com/mcp/` only when the user asks for tools that change data.
- The header command runs each time a chat connects. While `gh` is logged out it fails instead of sending
  an empty token; the user runs `gh auth login` in a terminal.
- Unverified: whether GitHub accepts the GitHub CLI token's scopes for every toolset. If the server
  rejects it, ask the user for a token in an environment variable: `"Authorization": "Bearer ${GITHUB_TOKEN}"`.

## After editing

The host reloads idle chats on its own and a busy chat picks the change up when it is idle. Tell the user
when a step is theirs: approving a repository server, or **Sign in** for a server that uses OAuth (both in
Settings › MCP servers). Do not ask them to restart RailDesign.

## Using MCP tools

- Tools are named `mcp__<server>__<tool>`. For a `deferred` server, call `tool_search` to load them.
- Subagents cannot call MCP tools: call them yourself and put what the subagent needs in its task.
- RailDesign asks the user before a call that may change data. A denied or cancelled call is final for that
  call; do not retry it without asking the user first.

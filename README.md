# pi-codemode-mcp

Pi extension that exposes MCP through two tools:

- `list_mcp_tools` — enumerates all MCP tools (shows first 20 inline, overflows full list to a temp file)
- `call_mcp` — runs JavaScript in a sandbox and lets the script call MCP servers

It also adds a `/mcp` command for status, enable/disable, reconnect, and auth setup.

## Configuration files

Loaded in merge order (later overrides earlier):

1. `~/.pi/agent/mcp.json`
2. `~/.pi/agent/.mcp.json`
3. `<cwd>/.pi/mcp.json`
4. `<cwd>/.mcp.json`

You can override with `--mcp-config /path/to/file.json`.

## `list_mcp_tools`

Parameters:

- `query` (optional): case-insensitive text match, or regex via `/pattern/flags`

The tool always shows the first 20 matches inline. If more matches exist, it writes the full list to a temp `.tsv` file so the agent can grep/rg it.

Each listed MCP tool includes a compact schema signature, with required fields marked by `*` and optional fields in brackets.

Only currently enabled MCP tools are listed.

## `/mcp` command

Use `/mcp` to manage MCP from interactive mode:

- `/mcp` — opens an interactive select menu (status, reconnect, auth, and per-server tool toggles)
- `/mcp status` — show server connection/auth state + enabled/disabled counts
- `/mcp enable <server> <tool|all>` — enable a specific MCP tool (or all tools for server)
- `/mcp disable <server> <tool|all>` — disable a specific MCP tool (or all tools for server)
- `/mcp reconnect [server]` — reconnect one/all servers and refresh metadata
- `/mcp auth <server>` — trigger auth setup flow

Tool enable/disable policies are persisted in:

- `~/.pi/agent/mcp-tool-policies.json`

### Auth behavior

- **OAuth flow (standard MCP auth)**
  - `/mcp auth <server>` starts an OAuth browser login flow with localhost callback (for URL-based servers).
  - received tokens are stored in:
    `~/.pi/agent/mcp-oauth/<server>/tokens.json`
  - then the server is reconnected.
  - if a server's auth metadata does **not** support dynamic client registration, `/mcp auth` falls back to bearer setup for the current session (for GitHub Copilot MCP, it will try `gh auth token` automatically).
- **Bearer servers (`auth: "bearer"` or bearer token config)**
  - if `bearerTokenEnv` is configured, `/mcp auth <server>` lets you paste a token into that env var for the current pi process.
  - if no `bearerTokenEnv`, it stores token in memory for the current session.

For OAuth servers that require pre-registered clients, you can provide:

- `oauthClientId`
- `oauthClientSecret` (optional)
- `oauthClientMetadataUrl` (optional)
- `oauthTokenEndpointAuthMethod` (optional)

in the server config entry.

## `call_mcp`

`call_mcp` takes JavaScript code only (plus optional timeout/state reset). Prefer batching: solve each user task in one script and use `Promise.all` for independent calls. Inside the script:

- `await call(server, tool, args)`
- `await readResource(server, uri)`
- `listTools(query?)`
- `servers` (array of configured server names)
- `tools` (map of server -> tool names)
- `resources` (map of server -> resources)
- `state` (persistent mutable object across calls)

Only tools currently enabled in MCP policy are visible/callable from `call_mcp`.

`call(server, tool, args)` throws on MCP tool errors (instead of returning nested `isError`) and includes parameter hints from schema. It also attempts one snake_case → camelCase retry for validation errors.

Example:

```js
const screenshots = await call("chrome-devtools", "take_screenshot", { format: "png" });
const repos = await call("github", "search_repositories", { query: "pi-mono" });

return {
  screenshot: screenshots,
  repos,
  knownServers: servers,
  firstChromeTools: tools["chrome-devtools"]?.slice(0, 10)
};
```

# Wiring Fallow's MCP server into an agent (paste-only)

`@butshouldwe/fallow-rush` exposes Fallow's **bundled** MCP server as a thin
exec passthrough - no wrapping, no re-serving. The plugin pins `fallow@3.6.0`,
so the server version is locked to the plugin version you installed.

**Verified against the real binary** (fallow-mcp 3.6.0, stdio JSON-RPC):
initialize handshake returns `serverInfo: { name: "fallow-mcp", version: "3.6.0" }`
with a `tools` capability; `tools/list` enumerates 31 tools including
`analyze`, `trace_export`, `trace_dependency`, `trace_file`, `impact`,
`get_blast_radius`, `check_changed`, `find_dupes`, `check_health`,
`project_info`, `fallow_explain`, and `list_suppressions` (new since 3.3.0).

## The snippet

Paste into your agent's MCP configuration (`.mcp.json` / `mcp_servers` shape),
substituting `<repo>` with the absolute path to your Rush repository:

```json
{
  "mcpServers": {
    "fallow": {
      "command": "<repo>/common/autoinstallers/rush-plugins/node_modules/.bin/fallow-rush",
      "args": ["mcp"],
      "cwd": "<repo>"
    }
  }
}
```

- `cwd` matters: Fallow analyzes the project it starts in. Point it at the
  repo root so workspace discovery sees every Rush project.
- The binary exists after any `rush` command has prepared the `rush-plugins`
  autoinstaller (e.g. `rush update`, or one `rush fallow` run).

## Why not `command: "rush", args: ["fallow-mcp"]`?

Verified empirically: Rush writes its banner and autoinstaller-preparation
chatter to **stdout** before the plugin runs, which corrupts MCP's stdio
JSON-RPC framing. `rush fallow-mcp` exists for interactive smoke tests, but
agent configs must exec the autoinstaller bin directly (it inherits stdio and
execs `fallow-mcp` with a clean stream).

## Policy

This file is deliberately a paste snippet, not an installer: fallow-rush never
writes into any agent's configuration — the human wires their own agents.

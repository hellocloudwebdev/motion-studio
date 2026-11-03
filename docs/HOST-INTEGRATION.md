# Host integration

Motion Studio shares one provider-neutral core but uses host-specific configuration.

## Claude Code
The installer copies skills to `~/.claude/skills`, copies specialist agent role files to `~/.claude/agents`, and registers a user-scope stdio MCP server when the `claude` CLI is detected. Plugin manifests are provided under `.claude-plugin/` for manual marketplace installation.

## Codex
The installer copies skills to `~/.agents/skills` and the legacy `~/.codex/skills` path. If the `codex` CLI is detected, it registers the local MCP server. A plugin manifest scaffold is available under `.codex-plugin/`.

## Cursor
The installer copies skills to `~/.cursor/skills` and merges a Motion Studio MCP entry into `~/.cursor/mcp.json`. Existing conflicting entries are preserved; a managed alternate name is used.

## Z Code and DeepSeek-compatible harnesses
The installer writes generic stdio MCP JSON files under the Motion Studio user config directory in `adapters/`. Import the generated configuration into the host's MCP settings and point it at the installed `scripts/mcp-launcher.mjs`.

## Security and compatibility
MCP server commands use an absolute local path. Preserve existing user settings. Host CLI syntax and plugin manifest schemas can change; verify against the installed host version before automating marketplace operations.

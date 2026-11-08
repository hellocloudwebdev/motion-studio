# Host integration

Motion Studio exposes one provider-neutral core through host-specific configuration. The installer registers three local stdio services:

- `motion-studio`: Canonical IR, planning, routing, HyperFrames compilation, rendering and QA.
- `aftereffects`: `@kumoproductions/mcp-aftereffects` through `scripts/adobe-mcp-launcher.mjs aftereffects`.
- `premiere-pro`: `premiere-pro-mcp` through `scripts/adobe-mcp-launcher.mjs premiere`.

The Adobe servers remain upstream dependencies; Motion Studio does not fork or reimplement their editor control surfaces.

## Safe defaults

- After Effects starts with `AE_MCP_READONLY=1`.
- `AE_MCP_ENABLE_EVAL` is always removed by the launcher.
- Premiere starts with `PREMIERE_MCP_CAPABILITIES=inspect` and the inspection tool pack.
- Premiere `unsafe-script` authority is never added by Motion Studio.
- Premiere UXP token is read from a user-only secret file at runtime and is not placed in the checked-in project or host MCP JSON.
- All three services use local stdio; no public TCP server is opened.

## Claude Code

The installer copies skills to `~/.claude/skills`, copies agent role files to `~/.claude/agents`, and calls the Claude CLI to register the three stdio MCP services where supported. Generated JSON fallback is under the Motion Studio user config `adapters/claude.mcp.json`.

## Codex

The installer copies skills to `~/.agents/skills` and legacy `~/.codex/skills`, then calls the Codex CLI to register the three services. Generated JSON fallback is under `adapters/codex.mcp.json`.

## Cursor

The installer copies skills to `~/.cursor/skills` and merges the three MCP entries into `~/.cursor/mcp.json`. Conflicting user entries are preserved under their original names; Motion Studio selects a managed alternate key.

## Z Code and DeepSeek-compatible harnesses

Generic stdio MCP JSON is written under the Motion Studio user config directory at `adapters/zcode.mcp.json` and `adapters/deepseek.mcp.json`. Import that configuration into the host's MCP settings and restart the host.

## Adobe host checks

After Effects: launch AE, open a copied test project and confirm its scripting preference **Allow Scripts to Write Files and Access Network**. The MCP can list and inspect context in read-only mode.

Premiere: open Premiere with a test project and active sequence. On 25.6+ install the pinned v1.30.0 UXP CCX in Creative Cloud Desktop and set the generated token in the panel. Use the upstream read-only `verify_premiere_connection` check. Older Premiere versions can use the signed CEP connector installed through the upstream npm command.

A successful MCP handshake does not prove an edit/export completed. Mutations require user approval, project checkpoints and post-operation readback.

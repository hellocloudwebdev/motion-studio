# Host integration — Motion Studio 0.4

Motion Studio exposes a provider-neutral core through host-specific configuration. The installer registers three local stdio MCP services:

- `motion-studio`: Canonical IR, planning, routing, HyperFrames compilation/rendering, QA and Adobe orchestration.
- `aftereffects`: `@kumoproductions/mcp-aftereffects` through `scripts/adobe-mcp-launcher.mjs aftereffects`.
- `premiere-pro`: `premiere-pro-mcp` through `scripts/adobe-mcp-launcher.mjs premiere`.

The Adobe servers remain upstream dependencies. Motion Studio does not fork their Adobe-control implementations.

## Safe defaults and workflow scopes

- After Effects starts with `AE_MCP_READONLY=1`.
- `AE_MCP_ENABLE_EVAL` is always removed.
- During an approved AE workflow, Motion Studio starts the server with `AE_MCP_READONLY=0` and `AE_MCP_ALLOW_CATEGORIES=comp,layer,text,transform,keyframe,render`; preview only calls `ae_context`, `ae_project_info` and `ae_catalog`. It does not call `ae_do`.
- Premiere starts with `PREMIERE_MCP_CAPABILITIES=inspect`.
- Approved Premiere workflow uses the limited tool list for import, new-sequence creation, readback, save and export. `unsafe-script` is never included.
- Premiere UXP token is loaded from a user-only secret file and never placed in checked-in projects or MCP JSON.
- All servers use local stdio; no public TCP service is opened.

## High-level Motion Studio MCP tools

1. `video.adobe_preview_ae_scene`: read current AE project, inspect live operation schemas and prepare the scene operation plan. The user must provide a new backup path.
2. `video.adobe_apply_ae_scene`: requires the preview ID and explicit user approval. Copies the saved non-dirty project, applies allowlisted operations, saves, reads back composition/layers and captures a PNG proof frame.
3. `video.adobe_preview_premiere_assembly`: validates scene render files, saved project identity, backup path and a new sequence name without mutation.
4. `video.adobe_apply_premiere_assembly`: after separate approval, backs up the project, imports scene files, creates a new sequence from clips, checks active sequence identity and structure, saves and optionally exports/verifies.

Approval IDs are single-use, expire after 30 minutes and are bound to the previewed project identity. After an uncertain mutation, Motion Studio returns `needs-reconciliation`; it does not blindly retry.

## Host-specific setup

### Claude Code
The installer stages skills under `~/.claude/skills`, agent role files under `~/.claude/agents`, and registers local MCP servers when the CLI is present.

### Codex
The installer stages skills under `~/.agents/skills` (plus the legacy `~/.codex/skills` path) and registers MCP servers through the CLI.

### Cursor
The installer stages skills under `~/.cursor/skills` and merges MCP entries into `~/.cursor/mcp.json`, preserving existing user entries.

### Z Code / DeepSeek-compatible clients
Generic stdio MCP JSON is written under the Motion Studio user config directory at `adapters/zcode.mcp.json` and `adapters/deepseek.mcp.json`. Import this configuration into the host's MCP settings and restart the host.

## Adobe prerequisites

After Effects: install via Creative Cloud, launch the app, enable **Allow Scripts to Write Files and Access Network**, open a saved project and close modal dialogs.

Premiere: the full Motion Studio 0.4 assembly path currently requires the upstream CEP connector. Close Premiere, then run `install.ps1 --install-premiere-cep` or `install.sh --install-premiere-cep`. UXP workflows remain available directly through the upstream server where its live capability probe supports them, but Motion Studio does not route the initial assembly flow to UXP.

A successful MCP handshake does not prove an edit/export completed. Host readback and output evidence are required.

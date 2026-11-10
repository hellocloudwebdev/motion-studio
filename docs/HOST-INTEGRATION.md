# Host integration

Motion Studio exposes one provider-neutral core through host-specific configuration. The installer registers three local stdio services:

- `motion-studio`: Canonical IR, planning, routing, HyperFrames compilation, rendering, QA, host preflight and stage authorization.
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

## Milestone 0.6 preflight

The orchestrator checks explicit evidence for every engine in the scene route, plus Premiere Pro for editorial assembly and FFmpeg for delivery. After Effects is considered ready only when the MCP server is connected and `ae_context` succeeds. Premiere is ready only when `verify_premiere_connection` succeeds. Other engines require an explicit positive `available` result.

Use `motion-studio preflight project.json --host-checks host-checks.json` to evaluate a saved set of host checks. Missing or unknown checks fail closed. The preflight command does not invent host status or launch editor operations.

The MCP server also exposes:
- `video.evaluate_host_readiness`
- `video.authorize_production_stage`

## Adobe mutation approvals

Read-only connections may inspect host state. When an Adobe client is opened in edit-enabled mode, each tool call must carry a time-bounded approval record matching the exact project ID, run ID, Adobe app, tool name and SHA-256 digest of the arguments. The default approval lifetime is ten minutes; the maximum is one hour. A changed argument payload or expired approval is rejected.

The production state machine separately requires project/run/stage-matched approvals and host readiness before entering Premiere assembly or final export. Delivery still requires a verified final-export artifact.

These records provide application-level governance and audit evidence; they are not cryptographic identity proof and cannot constrain direct calls made outside Motion Studio. A trusted local UI/host must obtain the producer's explicit confirmation before creating an approval record. The Adobe servers remain local stdio processes.

## Optional authenticated local HTTP runtime

The separate local runtime binds only to `127.0.0.1`. Before starting it, set `MOTION_STUDIO_TOKEN` to a cryptographically random secret of at least 32 bytes. Protected API routes require an exact bearer token match; `/health` returns only service liveness. `MOTION_STUDIO_PORT` must be an integer from 1024 to 65535. The HTTP runtime is not enabled by the stdio MCP registration.

## Claude Code

The installer copies skills to `~/.claude/skills`, copies agent role files to `~/.claude/agents`, and calls the Claude CLI to register the three stdio MCP services where supported. Generated JSON fallback is under the Motion Studio user config `adapters/claude.mcp.json`.

## Codex

The installer copies skills to `~/.agents/skills` and legacy `~/.codex/skills`, then calls the Codex CLI to register the three services. Generated JSON fallback is under `adapters/codex.mcp.json`.

## Cursor

The installer copies skills to `~/.cursor/skills` and merges the three MCP entries into `~/.cursor/mcp.json`. Conflicting user entries are preserved under their original names; Motion Studio selects a managed alternate key.

## Z Code and DeepSeek-compatible harnesses

Generic stdio MCP JSON is written under the Motion Studio user config directory at `adapters/zcode.mcp.json` and `adapters/deepseek.mcp.json`. Import that configuration into the host's MCP settings and restart the host.

## Live Adobe validation

After Effects: launch AE, open a copied test project and confirm its scripting preference **Allow Scripts to Write Files and Access Network**. The MCP can list and inspect context in read-only mode.

Premiere: open Premiere with a test project and active sequence. On 25.6+ install the pinned UXP connector in Creative Cloud Desktop and set the generated token in the panel. Use the upstream read-only `verify_premiere_connection` check. Older Premiere versions can use the signed CEP connector installed through the upstream npm command.

A successful MCP handshake does not prove an edit/export completed. Mutations require user approval, project checkpoints and post-operation readback. Milestone 0.6's CI does not replace live workstation validation.

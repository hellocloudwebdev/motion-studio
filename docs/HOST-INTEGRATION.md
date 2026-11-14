# Host integration

Motion Studio exposes one provider-neutral core through host-specific configuration. The installer registers three local stdio services:

- `motion-studio`: Canonical IR, planning, routing, HyperFrames compilation, rendering, QA, host preflight and stage authorization.
- `effectcraft`: EffectCraft's headless MCP server through `scripts/craft-mcp-launcher.mjs effectcraft` (`effectcraft-cli mcp`).
- `filmcraft`: FilmCraft's headless MCP server through `scripts/craft-mcp-launcher.mjs filmcraft` (`filmcraft-cli -- mcp`).

The craft tools remain upstream dependencies; Motion Studio does not fork or reimplement their editor control surfaces.

## Safe defaults

- The craft CLIs are alpha tools: Motion Studio does not rely on provider-side read-only switches; instead every mutating tool call passes the craft approval gate.
- No shell is involved: the launcher spawns the CLI with a fixed argv (`effectcraft-cli mcp`, `filmcraft-cli -- mcp`).
- No credentials or tokens are needed or stored for the craft tools.
- All three services use local stdio; no public TCP server is opened.

## Preflight

The orchestrator checks explicit evidence for every engine in the scene route, plus FilmCraft for editorial assembly and FFmpeg for delivery. A craft engine is considered ready only when its MCP server is connected and advertises at least one tool. Other engines require an explicit positive `available` result.

Use `motion-studio preflight project.json --host-checks host-checks.json` to evaluate a saved set of host checks. Missing or unknown checks fail closed. The preflight command does not invent host status or launch editor operations.

The MCP server also exposes:
- `video.evaluate_host_readiness`
- `video.authorize_production_stage`

## Craft mutation approvals

Inspection connections may read host state. When a craft client is opened in edit-enabled mode, each tool call must carry a time-bounded approval record matching the exact project ID, run ID, craft app, tool name and SHA-256 digest of the arguments. The default approval lifetime is ten minutes; the maximum is one hour. A changed argument payload or expired approval is rejected.

The production state machine separately requires project/run/stage-matched approvals and host readiness before entering FilmCraft assembly or final export. Delivery still requires a verified final-export artifact.

These records provide application-level governance and audit evidence; they are not cryptographic identity proof and cannot constrain direct calls made outside Motion Studio. A trusted local UI/host must obtain the producer's explicit confirmation before creating an approval record. The craft servers remain local stdio processes.

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

## Live craft-tool validation

EffectCraft: launch the app (or use the headless CLI) with a test composition and confirm `effectcraft-cli mcp` advertises tools; render a short comp via `effectcraft-cli render` and inspect the output with FFprobe.

FilmCraft: open a test project (or drive the JSON control channel with `--control <port>`) and confirm `filmcraft-cli -- mcp` advertises tools; import the Motion Studio FCPXML interchange and verify the assembled sequence before export.

A successful MCP handshake does not prove an edit/export completed. Mutations require user approval, project checkpoints and post-operation readback. CI does not replace live workstation validation — and both tools being alpha makes independent output inspection mandatory for every production run.

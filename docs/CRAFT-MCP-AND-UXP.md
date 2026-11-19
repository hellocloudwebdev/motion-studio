# Craft MCP servers and UXP panels

Motion Studio ships **two first-party MCP servers** — one per craft engine — plus **Adobe UXP operator panels** that drive them from inside After Effects and Premiere Pro. They wrap the same free craft CLIs the pass-through servers expose (`effectcraft-cli mcp`, `filmcraft-cli mcp`), but add Motion Studio conventions: zod-validated schemas, the producer-approval gate on mutations, and independent FFprobe/sha256 verification receipts (`isError` on every unverified artifact).

## The two layers

| Layer | Server name | Entry | What it is |
|---|---|---|---|
| Pass-through | `effectcraft`, `filmcraft` | `scripts/craft-mcp-launcher.mjs` | The craft CLIs' own headless MCP surfaces, unchanged |
| **Studio (first-party)** | `effectcraft-studio`, `filmcraft-studio` | `scripts/craft-studio-mcp-launcher.mjs` | Validated, approval-gated, verified tools built on the adapter packages |

Both layers launch over stdio from the root `mcp.json`; the studio servers are also registered in `adapters/zcode/mcp.json` and `adapters/deepseek/mcp.json`.

## effectcraft-studio (`packages/effectcraft-mcp-server`)

Read-only / planning (no approval):

- `effectcraft.check_engine` — resolve the CLI, read its version, verify the headless MCP connection (tool count + names).
- `effectcraft.list_commands` — the full engine command surface via `commands --json` (`--filter`, `--enabled`, limit).
- `effectcraft.describe_command` — one command's params doc; unknown ids fail with substring near-matches.
- `effectcraft.inspect_project` — the CLI `info` summary (item tree, active comp, layer stack).
- `effectcraft.get_property` / `effectcraft.layer_props` — typed property readback (`get` / `props --json`).
- `effectcraft.plan_scene` — pure IR → engine-command planning through the effectcraft-adapter (comp.new, layer.*, prop.set keyframes, expressions, effects).
- `effectcraft.render_frame` — single-frame PNG (`render-frame`) with sha256 receipt; `--transparent` supported.
- `effectcraft.render_scene` — stored-project workspace render through the adapter (checkpoints, FFprobe verification, fail-closed).

Mutations (producer approval required):

- `effectcraft.run_command`, `effectcraft.run_batch` — journaled engine sessions via `run --commands --json` with per-step attributed results.

Verified artifact generation (no approval, mirroring `video.render_project` policy):

- `effectcraft.render_comp` — full render flag surface (`h264|hevc|av1|prores|webm`, fps, resolution, quality, channels, bitrate, ProRes profile, start/end) with independent FFprobe verification + sha256 receipt; refuses to overwrite.

Verified live on EffectCraft 0.24.1: `file.newProject` takes no params; `run --json` returns per-step `[{"command": id, "result": …|null}]`; there is no `export` subcommand (that's FilmCraft).

## filmcraft-studio (`packages/filmcraft-mcp-server`)

Read-only / planning: `filmcraft.check_engine`, `filmcraft.list_commands`, `filmcraft.describe_command`, `filmcraft.inspect_project`, `filmcraft.inspect_sequence` (activates sequences in a throwaway temp copy so the producer's project is never modified), `filmcraft.render_frame`, `filmcraft.probe_media` (never `--allow-offline`), `filmcraft.plan_editorial_assembly`.

Mutations (approval required): `filmcraft.import_interchange`, `filmcraft.apply_transition`, `filmcraft.run_command`, `filmcraft.run_batch`.

Verified artifact generation: `filmcraft.export_master` (`h264|hevc|prores|dnxhr|png|wav`) — offline media fails closed with the `offlineMedia` list and is never certified; independent FFprobe verification + sha256 receipt.

Verified live on FilmCraft 0.20.1: `export` appends plain text after its JSON receipt; `sequence.open` does not persist across CLI processes.

## Approval gate

Mutating tools take `{ approval, projectId, runId, …operationArgs }`. The gate (`validateCraftOperationApproval`, from `packages/craft-mcp-client`) requires an approval record whose `argumentsSha256` matches the **stable-stringified operation arguments excluding the approval field**, scoped to the exact project, run, app and tool name, with a bounded lifetime (default 10 min, max 1 h). Rejections are `isError` results that explain how to mint an approval (`createEffectCraftApproval` / `createFilmcraftApproval`, mirroring `createCraftOperationApproval`). The UXP panels create approvals in-panel from operator fields (SHA-256 via WebCrypto over the same stable stringify), so nothing mutates without an explicit operator confirmation — the same governance rule as the Adobe stack.

## HTTP transport for UXP panels

Both servers run their stdio MCP surface by default and an HTTP surface with `--http`:

```bash
node packages/effectcraft-mcp-server/src/index.mjs --http          # 127.0.0.1:7420/mcp
node packages/filmcraft-mcp-server/src/index.mjs --http --port 8081 # any port; default 7430
```

- Binds **strictly to 127.0.0.1** (refuses `--host 0.0.0.0`); only `/mcp` is served.
- Optional shared secret: set `MOTION_STUDIO_CRAFT_HTTP_TOKEN`; clients must send it as the `x-motion-studio-token` header (403 otherwise; timing-safe compare; never logged).
- Stateless Streamable-HTTP MCP (fresh transport per request, `enableJsonResponse`), protocol `2025-06-18`.
- The panels embed a dependency-free client (`uxp/shared/mcp-http-client.js`, UMD) that also parses SSE-framed responses.

## UXP panels (`uxp/`)

- `uxp/effectcraft-panel` — After Effects panel (manifest v5, host `AEFT` ≥ 27.1.0 — AE UXP is beta-only; if UDT refuses the manifest, compare `host` against UDT's `ae-quick-starter` template): engine status, command browser, approval-gated command console, scene render, comp render, receipt log.
- `uxp/filmcraft-panel` — Premiere Pro panel (host `premierepro` ≥ 25.2.0, UXP GA): engine status, FCPXML interchange import, sequence inspector, transitions, export master with verification receipts, media probe, receipt log.

Load both with the **UXP Developer Tool** (Add Plugin → `manifest.json` → Load); see `uxp/README.md` for prerequisites, the token setting, and the macOS Premiere `http://` caveat (Windows is fine; macOS Premiere disallows plain http — use an https terminator or run the panel workflow on Windows).

## Security posture

- No shell is involved anywhere: every CLI drive is a fixed argv array with `shell: false` and timeouts.
- Session JSONL lives in fresh OS temp dirs, never in the repo.
- Outputs are never silently overwritten; receipts carry sha256 so downstream consumers can verify independently.
- HTTP mode is loopback-only, optional-token, and never starts automatically — the stdio MCP registration does not open any TCP port.

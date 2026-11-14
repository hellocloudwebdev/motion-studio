# Motion Studio

**Motion Studio** is a cross-platform AI video-production system built around a versioned Canonical Video Project IR. It coordinates production agents, reusable skills, HyperFrames/GSAP rendering, FilmCraft/EffectCraft MCP bridges, licensed Adobe MCP bridges, FFmpeg, evidence-driven QA and bounded repair.

> **Current milestone: 1.0.0-alpha.1.** Milestones 0.5–0.8 added evidence-driven QA, verified production approvals, governed asset intake and local media derivatives; 0.9 adds frame-accurate editorial assembly planning; 1.0 adds FCPXML interchange export with provenance. Since 2026-11-14 Motion Studio ships a **dual specialist/editorial stack**: the free open-source **EffectCraft + FilmCraft** tools are the default engines, and the licensed **Adobe After Effects/Premiere Pro** integrations remain fully supported for subscribed hosts — a scene's `engineHint` (or `MOTION_STUDIO_EDITORIAL_ENGINE`) picks which one a production uses.

## Install on a new PC

**Windows PowerShell**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

**macOS / Linux**
```bash
chmod +x install.sh
./install.sh
```

The installer requires Node.js 24+. macOS/Linux bootstrap a checksum-verified Node 26 user-local runtime where needed; Windows uses WinGet. It installs pinned npm dependencies including HyperFrames, GSAP and Three.js, prepares the HyperFrames browser, and can install FFmpeg/Blender through the OS package manager.

The default specialist/editorial engines are **free and open source**: install [EffectCraft](https://github.com/storytold/effectcraft) (motion graphics, compositing, VFX) and [FilmCraft](https://github.com/storytold/filmcraft) (editorial timeline, color, sound post, export) from their GitHub releases pages or getartcraft.com. Both are alpha Rust tools exposing headless MCP servers over stdio (`effectcraft-cli mcp`, `filmcraft-cli -- mcp`); Motion Studio detects the CLIs (or honors `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI` overrides for portable installs) and registers them for your AI host.

Licensed **Adobe** hosts remain fully supported: After Effects and Premiere Pro connect through their upstream npm MCP packages (read-only onboarding, exact-operation approvals), and Adobe products are still installed/activated by you through Creative Cloud — Motion Studio never automates licensing.

See [Installation](docs/INSTALLATION.md), the [installer policy](docs/INSTALLER-CRAFT-POLICY.md) and [Host integration](docs/HOST-INTEGRATION.md).

## Production stack (dual: free default + licensed optional)

| Responsibility | Free default engine | Licensed optional engine |
|---|---|---|
| Programmable 2D, motion graphics, typography | HyperFrames + GSAP | — |
| Advanced motion graphics, compositing, effects and VFX | EffectCraft via its MCP/CLI (alpha) | After Effects via upstream MCP |
| Editorial timeline, color, sound post and final assembly | FilmCraft via its MCP/CLI (alpha) | Premiere Pro via upstream MCP |
| 3D, simulation and product visualization | Blender | — |
| Procedural/WebGL 3D | Three.js | — |
| Media processing, encoding and inspection | FFmpeg / FFprobe | — |

## Try the renderer and QA

```bash
npm install
npm test
npm run validate:example
npm run route:example
npm run compile:example
node apps/cli/src/index.mjs render templates/startup-ad/project.json --quality draft --workers 1
```

The renderer creates a HyperFrames project, renders an MP4, probes the result with FFprobe and writes sampled frame evidence plus a render receipt. Replace sample placeholder assets with licensed/user-owned media before delivery.

## Natural-language production planning

Configure `OPENROUTER_API_KEY` in a local environment (never as a CLI argument or committed file), then run:

```bash
node apps/cli/src/index.mjs plan "Explain how community solar works" --duration 45 --audience "first-time renters" --output projects/community-solar
```

The default model is OpenRouter's `openrouter/free` router. The command is an optional standalone path: it produces a validated Canonical Video IR and a creative-plan JSON, but does not render, generate narration audio, or accept the production. When Motion Studio is used as an MCP bridge under a host harness, the harness supplies model reasoning and calls provider-neutral planning/compilation tools; no Motion Studio model key is needed. Research uses OpenRouter web search only when enabled with `--allow-web-search`. Search may incur charges separate from free-model inference, so leave it off unless that cost is approved. See [OpenRouter provider setup](docs/OPENROUTER-CREATIVE-PIPELINE.md).

## Milestone 0.7: asset intelligence and media intake

Index a media folder, detect duplicates and record exact file checksums:

```bash
motion-studio assets scan ./media --output ./asset-registry.json
motion-studio assets verify ./asset-registry.json
motion-studio assets probe ./media/clip.mp4
motion-studio assets approve-rights ./asset-registry.json --asset-id <asset-id> --actor "Producer" --license "Licensed stock" --usage "Online advertising"
motion-studio assets attach ./project.json --registry ./asset-registry.json --output ./project-with-assets.json
```

Asset scans are read-only and stream SHA-256 hashing for large files. New media defaults to `needs-review`; an approval record is a producer's audit assertion, not legal clearance. Verification detects changed/missing bytes but does not validate license terms. See [Asset library](docs/ASSET-LIBRARY.md) and [Milestone 0.7](docs/MILESTONE-0.7-IMPLEMENTATION-PLAN.md).

## Milestone 1.0: editorial interchange export

Export a validated editorial manifest to FCPXML plus a provenance sidecar:

```bash
motion-studio interchange export assembly.json --asset-root ./media --output sequence.fcpxml --manifest editorial-handoff.json
```

Relative media paths are resolved only under the explicit asset root. The exporter preserves rational frame timing, source in-points, track lanes, source checksums and rights-review state. It fails closed on unresolved files and unsupported URI schemes. This writes an interchange file — FilmCraft imports FCPXML natively — but does not launch FilmCraft, import the sequence or perform edits. See [Editorial interchange](docs/EDITORIAL-INTERCHANGE.md) and [Milestone 1.0](docs/MILESTONE-1.0-IMPLEMENTATION-PLAN.md).

## Milestone 0.9: editorial assembly planning

Generate a deterministic sequence manifest from Canonical Video IR:

```bash
motion-studio editorial plan project.json --output assembly.json
motion-studio editorial validate assembly.json
```

The planner lays scenes sequentially in integer frames, places layers on deterministic overlap-aware video/audio/graphics tracks, and carries source URI, checksum and rights-review metadata into the manifest. It flags unresolved media and unreviewed rights. This is a planning handoff only; it does not create or modify editorial-engine projects. See [Editorial assembly](docs/EDITORIAL-ASSEMBLY.md) and [Milestone 0.9](docs/MILESTONE-0.9-IMPLEMENTATION-PLAN.md).

## Milestone 0.8: media derivatives and preview artifacts

Create local proxies and review assets without modifying source media:

```bash
motion-studio media derive ./media/clip.mp4 --output-dir ./media/derived
motion-studio media derive ./media/music.wav --output-dir ./media/derived
motion-studio media derive ./media/still.png --output-dir ./media/derived
```

Video creates an H.264/AAC proxy and representative thumbnail, audio creates a waveform PNG, and raster images create a bounded JPEG preview. Every output is hashed in a provenance manifest; existing outputs are not overwritten unless `--overwrite` is supplied. These files are previews, not delivery masters. See [Media derivatives](docs/MEDIA-DERIVATIVES.md) and [Milestone 0.8](docs/MILESTONE-0.8-IMPLEMENTATION-PLAN.md).

## Milestone 0.6: host preflight and approval gates

Create a JSON file containing actual local host-check evidence, then run:

```bash
motion-studio preflight templates/startup-ad/project.json --host-checks host-checks.json
```

Example:
```json
{
  "hyperframes": { "available": true },
  "blender": { "available": true },
  "effectcraft": { "serverConnected": true, "toolCount": 12 },
  "filmcraft": { "serverConnected": true, "toolCount": 8 },
  "ffmpeg": { "available": true }
}
```

Preflight fails closed if any routed engine, FilmCraft assembly host or FFmpeg delivery tool lacks positive evidence. Do not mark a host available unless the check actually succeeded.

Edit-enabled craft MCP calls require a short-lived approval bound to the project, run, app, tool name and exact arguments. Production-run transitions into FilmCraft assembly and final export require matching approvals and verified host readiness. Approval records are audit/governance records, not cryptographic identity proof.

See [Milestone 0.5](docs/MILESTONE-0.5-IMPLEMENTATION-PLAN.md), [Milestone 0.6](docs/MILESTONE-0.6-IMPLEMENTATION-PLAN.md) and [Milestone 0.7](docs/MILESTONE-0.7-IMPLEMENTATION-PLAN.md).

## Architecture

- **Canonical Video IR** defines production intent, timing, typography, assets, motion, QA, provenance and delivery contracts.
- **Agents and skills** own specialist production responsibilities and reusable procedures.
- **Orchestrator** manages dependencies, leases, host preflight, approval gates and bounded repair loops.
- **Engine router** chooses per-layer renderers.
- **Render manager** compiles and renders HyperFrames compositions and verifies output artifacts.
- **Craft MCP client** connects to the EffectCraft and FilmCraft headless MCP servers over local stdio with exact-operation approval gates for every mutation.
- **QA and repair** inspect actual output evidence, create defects and request scoped rebuilds.
- **Learning** proposes versioned workflow/skill improvements; it cannot silently change code or permissions.

## Capability boundary

This is an alpha, not a production-ready one-click film studio. CI verifies synthetic media and deterministic orchestration logic. EffectCraft and FilmCraft are themselves alpha tools: real comp creation, sequence assembly, color/sound work and final exports still require live validation on a workstation with both craft CLIs installed. Motion Studio does not claim to perform a full end-to-end craft edit/export automatically.

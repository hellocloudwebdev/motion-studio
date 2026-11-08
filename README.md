# Motion Studio

**Motion Studio** is a cross-platform AI video-production system built around a versioned Canonical Video Project IR. It coordinates production agents, reusable skills, HyperFrames/GSAP rendering, Adobe MCP bridges, FFmpeg, evidence-driven QA and bounded repair.

> **Current milestone: 0.8.0-alpha.1.** Milestones 0.5–0.7 added evidence-driven QA, verified production approvals and governed asset intake; 0.8 adds local, hashed media previews and proxy generation.

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

The installer requires Node.js 24+. macOS/Linux bootstrap a checksum-verified Node 26 user-local runtime where needed; Windows uses WinGet. It installs pinned npm dependencies including HyperFrames, GSAP, Three.js, `@kumoproductions/mcp-aftereffects@0.3.2` and `premiere-pro-mcp@1.29.0`, prepares the HyperFrames browser, and can install FFmpeg/Blender through the OS package manager.

Adobe desktop apps are licensed: the user must sign into Creative Cloud and install/activate them. Motion Studio opens Adobe's official installation workflow and verifies the apps afterward; it does not automate login or licensing.

After Effects and Premiere have separate local stdio MCP servers. Onboarding uses read-only / inspect-only authority. Premiere 25.6+ can use the pinned authenticated UXP connector; older hosts can use CEP compatibility. The Premiere UXP token is stored in a user-only secret file and read by the local MCP launcher.

See [Installation](docs/INSTALLATION.md), [Adobe policy](docs/INSTALLER-ADOBE-POLICY.md) and [Host integration](docs/HOST-INTEGRATION.md).

## Locked production stack

| Responsibility | Engine |
|---|---|
| Programmable 2D, motion graphics, typography | HyperFrames + GSAP |
| Advanced motion, compositing, tracking and VFX | After Effects via upstream MCP |
| Editorial timeline and final assembly | Premiere Pro via upstream MCP |
| 3D, simulation and product visualization | Blender |
| Procedural/WebGL 3D | Three.js |
| Media processing, encoding and inspection | FFmpeg / FFprobe |

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
  "afterEffects": { "serverConnected": true, "contextAvailable": true },
  "premiere": { "serverConnected": true, "hostVerified": true },
  "ffmpeg": { "available": true }
}
```

Preflight fails closed if any routed engine, Premiere assembly host or FFmpeg delivery tool lacks positive evidence. Do not mark a host available unless the check actually succeeded.

Edit-enabled Adobe MCP calls require a short-lived approval bound to the project, run, app, tool name and exact arguments. Production-run transitions into Premiere assembly and final export require matching approvals and verified host readiness. Approval records are audit/governance records, not cryptographic identity proof.

See [Milestone 0.5](docs/MILESTONE-0.5-IMPLEMENTATION-PLAN.md), [Milestone 0.6](docs/MILESTONE-0.6-IMPLEMENTATION-PLAN.md) and [Milestone 0.7](docs/MILESTONE-0.7-IMPLEMENTATION-PLAN.md).

## Architecture

- **Canonical Video IR** defines production intent, timing, typography, assets, motion, QA, provenance and delivery contracts.
- **Agents and skills** own specialist production responsibilities and reusable procedures.
- **Orchestrator** manages dependencies, leases, host preflight, approval gates and bounded repair loops.
- **Engine router** chooses per-layer renderers.
- **Render manager** compiles and renders HyperFrames compositions and verifies output artifacts.
- **Adobe MCP client** connects to upstream AE and Premiere servers over local stdio with read-only defaults and exact-operation approval gates.
- **QA and repair** inspect actual output evidence, create defects and request scoped rebuilds.
- **Learning** proposes versioned workflow/skill improvements; it cannot silently change code or permissions.

## Capability boundary

This is an alpha, not a production-ready one-click film studio. CI verifies synthetic media and deterministic orchestration logic. Real After Effects/Premiere connections, edit behavior, comp creation, sequence assembly and final exports still require live validation on a workstation with licensed Adobe applications. Milestone 0.6 does not claim to perform a full end-to-end Adobe edit/export automatically.

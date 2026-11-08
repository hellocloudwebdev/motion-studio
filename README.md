# Motion Studio

**Motion Studio** is a cross-platform AI video-production system built around a versioned Canonical Video Project IR. It coordinates production agents, reusable skills, HyperFrames/GSAP rendering, Adobe MCP bridges, FFmpeg, QA and bounded repair.

> **Current branch: 0.3.0-alpha.1.** This milestone adds the first executable IR-to-HyperFrames compiler and MP4 render/inspection pipeline, plus local MCP clients and installer configuration for the upstream After Effects and Premiere Pro MCP servers. Live Adobe-host verification still requires the user's licensed desktop applications.

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

The installer requires Node.js 24+. macOS/Linux bootstrap a checksum-verified Node 26 user-local runtime where needed; Windows uses WinGet. It installs pinned npm dependencies including HyperFrames, GSAP, Three.js, `@kumoproductions/mcp-aftereffects@0.3.2` and `premiere-pro-mcp@1.30.0`, prepares the HyperFrames browser, and can install FFmpeg/Blender through the OS package manager.

The installer detects Adobe Creative Cloud, After Effects and Premiere Pro. Adobe desktop apps are licensed: the user must sign into Creative Cloud and install/activate them. Motion Studio opens Adobe's official installation workflow and verifies the apps afterward; it does not automate login or licensing.

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

## Try the local render and delivery path

```bash
npm install
npm test
npm run validate:example
npm run route:example
npm run compile:example
node apps/cli/src/index.mjs render templates/startup-ad/project.json --quality draft --workers 1
node apps/cli/src/index.mjs deliver templates/startup-ad/project.json projects/opendoor-startup-ad/renders/opendoor-startup-ad-draft.mp4
```

The renderer compiles the IR, runs HyperFrames lint/runtime/layout checks, renders with one worker, probes the MP4 and stores scene-sampled frame evidence. The delivery command transcodes each declared profile, probes outputs, creates a thumbnail, packages source/provenance/assets/captions and writes a receipt. It returns a nonzero status while production evidence is incomplete. The startup-ad sample routes a Blender scene and references missing image/footage, so its render is deliberately not production-ready. For a clean local acceptance path, use `templates/kinetic-type/project.json`:

```bash
node apps/cli/src/index.mjs render templates/kinetic-type/project.json --quality draft --workers 1
node apps/cli/src/index.mjs deliver templates/kinetic-type/project.json projects/kinetic-type-demo/renders/kinetic-type-demo-draft.mp4
```

That fixture is a silent typography demo, not a narrated production.

## Architecture

- **Canonical Video IR** defines production intent, timing, typography, assets, motion and delivery contracts.
- **Agents and skills** own specialist production responsibilities and reusable procedures.
- **Orchestrator** manages dependencies, leases and bounded repair loops.
- **Engine router** chooses per-layer renderers.
- **Render manager** compiles and renders HyperFrames compositions and verifies output artifacts.
- **Adobe MCP client** connects to upstream AE and Premiere servers over local stdio.
- **QA and repair** inspect actual output evidence, create defects and request scoped rebuilds.
- **Learning** proposes versioned workflow/skill improvements; it cannot silently change code or permissions.

## Important capability boundary

This is a 0.3 alpha, not yet a production-ready one-click film studio. The HyperFrames compiler, local draft rendering, FFmpeg finishing and package generation are implemented. A primitive-based Blender frame-sequence adapter exists but has not run on a Blender host. Actual After Effects/Premiere edits require licensed apps and live host validation. Three.js rendering, natural-language production generation, Premiere interchange/sequence automation, AI QA/repair and cross-platform release evidence remain unimplemented. See [roadmap status](docs/IMPLEMENTATION-STATUS-1.0.md).

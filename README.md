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

The installer requires Node.js 24+. macOS/Linux bootstrap a checksum-verified Node 26 user-local runtime where needed; Windows uses WinGet. It installs pinned npm dependencies including HyperFrames, GSAP, Three.js, `@kumoproductions/mcp-aftereffects@0.3.2` and `premiere-pro-mcp@1.28.0`, prepares the HyperFrames browser, and can install FFmpeg/Blender through the OS package manager.

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

## Try the first renderer

```bash
npm install
npm test
npm run validate:example
npm run route:example
npm run compile:example
node apps/cli/src/index.mjs render templates/startup-ad/project.json --quality draft --workers 1
```

The renderer creates `projects/opendoor-startup-ad/engines/hyperframes/index.html`, renders an MP4 with one worker, checks the result with FFprobe and writes sampled frame evidence plus a render JSON receipt. The sample includes intentional placeholder assets; replace those with licensed/user-owned media before treating its output as a delivery.

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

This is a 0.3 alpha, not yet a production-ready one-click film studio. The HyperFrames compiler and MP4 pipeline are implemented, and Adobe MCP packages/configuration are installed by the installer. Actual After Effects/Premiere connection and editing require licensed app installation, user trust prompts and live host validation. Blender and Three.js render adapters, deep visual-critic repair, final Premiere sequence automation and persistent learning service remain follow-on work.

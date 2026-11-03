# Motion Studio

**Motion Studio** is a cross-platform AI video-production environment. It coordinates specialist agents, skills, templates, creative software and quality gates through a versioned Canonical Video Project IR.

> **Current release: 0.2.0 installer foundation.** This repository includes Windows/macOS/Linux bootstrap scripts, npm dependency installation, FFmpeg and Blender package-manager integration, HyperFrames CLI installation, host skill copying, local MCP registration and a system doctor. Engine execution adapters remain phased implementation work; the installer does not claim to make an unimplemented renderer production-ready.

## Install on a new PC

**Windows PowerShell**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

**macOS / Linux**
```bash
chmod +x install.sh && ./install.sh
```

The bootstrapper checks Node.js 22+, installs a user-local Node runtime when needed, stages Motion Studio into a stable per-user app directory, and invokes the cross-platform installer. The installer installs workspace dependencies (GSAP and Three.js), FFmpeg, HyperFrames CLI and browser support, and offers Blender. It stages skills for supported hosts and configures MCP where supported.

Use `./install.sh --yes` or `.\install.ps1 --yes` for non-interactive setup. Use `--minimal`, `--skip-software`, `--skip-hosts` or `--dry-run` to control setup. See `docs/INSTALLATION.md`.

## Licensed software

After Effects, Premiere Pro, Adobe Media Encoder, Illustrator, Photoshop and Audition require Adobe Creative Cloud installation and a valid license/sign-in. These cannot be legitimately installed or activated silently. See `docs/SOFTWARE-MATRIX.md`.

## Locked production stack

| Responsibility | Primary system |
|---|---|
| Programmable 2D, text, graphics | HyperFrames + GSAP |
| Advanced motion, VFX, compositing | Adobe After Effects |
| Editorial timeline and final assembly | Adobe Premiere Pro |
| Adobe render queue | Adobe Media Encoder |
| 3D and simulation | Blender; Three.js for browser/WebGL scenes |
| Media processing and delivery | FFmpeg |

## Architecture

- **IR** defines the intended video, timing, assets, typography, motion and delivery contracts.
- **Agents** own specialist production responsibilities.
- **Skills** contain reusable procedures, references and checks.
- **Orchestrator** manages dependencies and bounded retries.
- **Engine router** selects engines for each scene layer.
- **QA and repair** classify defects, assign specialists and re-inspect changed output.
- **Memory and learning** retain project decisions and propose versioned skill changes.
- **Adapters** expose shared capabilities through supported AI hosts and generic MCP.

## Verify

```bash
node scripts/doctor.mjs
npm test
npm run test:installer
npm run validate:example
npm run route:example
```

## Current capability boundary

This release makes the repository and setup process portable. It does not yet provide finished render adapters for all advertised engines. The MCP server supports project templates, IR validation, scene routing, execution graph generation, deterministic QA and typography scale planning. Actual rendering remains disabled until a concrete adapter passes compatibility checks and returns verifiable output.

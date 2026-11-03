# Motion Studio

**Motion Studio** is a cross-platform AI video-production environment. It coordinates specialist agents, skills, templates, creative software and quality gates through a versioned Canonical Video Project IR.

> **Current release: 0.2.0 installer foundation.** The repository includes Windows/macOS/Linux bootstrap scripts, npm workspace installation, FFmpeg and Blender package-manager integration, HyperFrames CLI/browser setup, host skill staging, generic MCP configuration and a local environment doctor. Renderer execution adapters remain phased implementation work; installation does not claim to make an unimplemented renderer production-ready.

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

The bootstrapper requires Node.js 22+ (Windows uses WinGet to install Node LTS when needed; macOS/Linux bootstrap a checksum-verified Node.js 26 runtime when needed). The installer stages Motion Studio into a per-user application directory, installs workspace dependencies, and installs HyperFrames CLI/browser support. With `--yes`, it attempts FFmpeg and Blender installation through the available OS package manager. It stages skills for Claude Code, Codex and Cursor, configures Cursor MCP, registers MCP with detected Claude/Codex CLIs, and writes generic MCP configuration for Z Code and DeepSeek-compatible hosts.

Use `./install.sh --yes` or `.\install.ps1 --yes` for non-interactive installation of supported free/open-source components. Use `--minimal`, `--skip-software`, `--skip-hosts` or `--dry-run` to control setup. See `docs/INSTALLATION.md`.

## Licensed software

After Effects, Premiere Pro, Adobe Media Encoder, Illustrator, Photoshop and Audition require Adobe Creative Cloud installation and a valid license/sign-in. They cannot be legitimately installed or activated silently. See `docs/SOFTWARE-MATRIX.md`.

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
- **Adapters** expose shared capabilities through host-specific configuration and generic MCP.

## Verify

```bash
npm install
npm test
npm run validate:example
npm run route:example
node scripts/doctor.mjs
```

## Current capability boundary

This is a working planning and integration foundation, not yet a finished automated video renderer. The MCP server exposes project-template creation, IR validation, scene routing, execution-graph generation, deterministic QA and typography-scale planning. Actual rendering remains disabled until a concrete adapter passes compatibility checks and returns verifiable output.

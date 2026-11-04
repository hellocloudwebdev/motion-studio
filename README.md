# Motion Studio

**Motion Studio** is a cross-platform AI video-production system built around a versioned Canonical Video Project IR. It coordinates specialist production agents, HyperFrames/GSAP rendering, upstream Adobe MCP servers, FFmpeg, QA and governed repair.

> **Current milestone: 0.4.0-alpha.1.** This adds high-level, approval-bound After Effects scene creation and Premiere scene-assembly workflows on top of the 0.3 HyperFrames renderer. These integrations are mocked/tested in CI; real Adobe-host execution still needs licensed Windows/macOS host receipts.

## Install on a new PC

**Windows PowerShell**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\\install.ps1
```

**macOS / Linux**
```bash
chmod +x install.sh
./install.sh
```

The installer requires Node.js 24+. macOS/Linux bootstrap a checksum-verified Node 26 user-local runtime where needed; Windows uses WinGet. It installs pinned npm packages including HyperFrames, GSAP, Three.js, `@kumoproductions/mcp-aftereffects@0.3.2` and `premiere-pro-mcp@1.29.0`, prepares the HyperFrames browser, and can install FFmpeg/Blender through the OS package manager.

Adobe desktop apps are licensed. Motion Studio detects them and opens the official Creative Cloud installation workflow, but users must sign in, install and activate their own entitled products. It cannot bypass Adobe licensing, accounts or trust prompts.

For the first Motion Studio 0.4 Premiere assembly workflow, the upstream **CEP compatibility bridge** is required. Close Premiere, then run `install.ps1 --install-premiere-cep` or `./install.sh --install-premiere-cep`. The upstream UXP connector is separate and may be used by UXP-specific upstream tools, but 0.4's sequence-import workflow is CEP-only. The Premiere UXP token, when configured, remains in a user-only secret file.

See [Installation](docs/INSTALLATION.md), [Adobe setup policy](docs/INSTALLER-ADOBE-POLICY.md) and [Host integration](docs/HOST-INTEGRATION.md).

## Locked production stack

| Responsibility | Engine |
|---|---|
| Programmable 2D, motion graphics and typography | HyperFrames + GSAP |
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

The renderer compiles Canonical IR to HyperFrames HTML/GSAP and can render an MP4, inspect it with FFprobe and save sampled-frame evidence. The Opendoor sample contains intentional placeholder media; replace them with licensed/user-owned assets before treating the output as a delivery. The complete MP4 path still needs a controlled end-to-end render receipt.

## Adobe MCP workflows

Motion Studio registers three local stdio MCP servers:

- `motion-studio`: Canonical IR, routing, render, QA and production orchestration.
- `aftereffects`: upstream AE MCP; read-only by default, edit categories scoped per approved workflow, arbitrary ExtendScript eval disabled.
- `premiere-pro`: upstream Premiere MCP; inspect-only by default, explicit limited tools for an approved workflow, `unsafe-script` disabled.

New high-level MCP tools:
- `video.adobe_preview_ae_scene` → read project state, inspect the live AE operation catalog and return a one-time approval ID without changing the project.
- `video.adobe_apply_ae_scene` → after explicit user approval, back up the saved non-dirty project, create supported IR text/shape layers, save, read back the comp and capture a PNG proof frame.
- `video.adobe_preview_premiere_assembly` → validate rendered scene files and project/backup paths without mutation.
- `video.adobe_apply_premiere_assembly` → after separate approval, back up the project, import verified renders, create a **new** sequence, verify active sequence identity/structure and save.

The initial AE adapter supports editable text and rectangular solid layers, style/transform and basic fade/fade-up keyframes when advertised by the live catalog. Unsupported layer types are returned as explicit warnings. The initial Premiere assembly uses CEP because the upstream UXP backend has a different import/sequence API; existing user timelines are not destructively edited. A failed or uncertain Adobe mutation is not blindly retried.

## Architecture and delivery boundary

- **Canonical Video IR** remains the source of truth; Adobe projects and renderer outputs are derived.
- **Agents and skills** define specialist production roles and reusable workflows.
- **Orchestrator** plans dependencies, enforces approvals, single-writer workflow and reconciliation.
- **Engine router** chooses engines by layer capabilities.
- **Render manager** compiles and verifies HyperFrames media.
- **Adobe orchestrator** uses live tool catalogs, operation-schema validation, project backups and host readback.
- **QA and repair** must be evidence-based and bounded.
- **Learning** proposes reviewed workflow/skill improvements; it cannot silently change code, dependencies or permissions.

## What is not claimed complete

0.4 is an alpha integration milestone, not the final production-ready studio or architecture lock. CI tests the IR mapping, approval lifecycle, project backup safety and mocked MCP workflows. Real After Effects/Premiere project edits and export still need licensed-host test receipts. Blender/Three.js renderers, broader Premiere editorial editing, full multimodal visual/audio QA, automatic defect repair, persistent production memory and final installer/release validation remain subsequent work.

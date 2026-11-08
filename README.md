# Motion Studio

**Motion Studio** is a cross-platform AI video-production system built around a versioned Canonical Video Project IR. It coordinates specialist production agents, HyperFrames/GSAP rendering, Adobe MCP hosts, FFmpeg, QA and governed repair.

> **Current milestone: 0.5.0-alpha.1 (in progress).** This branch starts the stateful production runtime: a provider-neutral agent dispatcher, durable local run journal and bounded repair planner. The 0.4 Adobe host acceptance gates remain tracked separately and require licensed desktop-host evidence.

## 0.5 runtime foundation

- `@motion-studio/agent-runtime`: capability-scoped, project-isolated task dispatch with idempotency and reconciliation-required timeout behavior.
- `@motion-studio/run-store`: append-only JSONL production-run journal with per-run revisions, duplicate-event protection and incomplete-tail recovery.
- `@motion-studio/repair-planner`: groups QA defects into scene/owner-scoped repair tasks, merges adjacent frame ranges, enforces repair-cycle limits and requires evidence plus per-defect retests.

See [0.5 scope](docs/MILESTONE-0.5-SCOPE.md), [implementation plan](docs/MILESTONE-0.5-IMPLEMENTATION-PLAN.md) and [ADR-019](docs/ADR-019-DURABLE-RUN-JOURNAL.md). The scheduler, project memory, multimodal QA evidence pipeline and complete restart-safe sample production run are still under development.

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

The installer requires Node.js 24+. It installs pinned npm packages including HyperFrames, GSAP, Three.js and the upstream Adobe MCP integrations. Adobe desktop applications are licensed: Motion Studio detects them and opens the official Creative Cloud workflow, but users must sign in, install and activate their own entitled products.

See [Installation](docs/INSTALLATION.md), [Adobe setup policy](docs/INSTALLER-ADOBE-POLICY.md) and [Host integration](docs/HOST-INTEGRATION.md).

## Production stack

| Responsibility | Engine |
|---|---|
| Programmable 2D, motion graphics and typography | HyperFrames + GSAP |
| Advanced motion, compositing, tracking and VFX | After Effects via upstream MCP |
| Editorial timeline and final assembly | Premiere Pro via upstream MCP |
| 3D, simulation and product visualization | Blender |
| Procedural/WebGL 3D | Three.js |
| Media processing, encoding and inspection | FFmpeg / FFprobe |

DaVinci Resolve is not part of the locked production stack.

## Current validation boundary

0.5 is a development milestone, not a completed release. Real licensed After Effects and Premiere Pro execution, project save/readback and export receipts remain required to close the 0.4 host-acceptance gate. A passing mocked MCP test is not a substitute for a real Adobe host.

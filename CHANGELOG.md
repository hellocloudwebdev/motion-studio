# Changelog

## 0.4.0-alpha.1 — Adobe production orchestration

- Added an Adobe orchestration workspace with Canonical IR to After Effects composition planning for text/shape layers.
- Added live AE MCP tool/catalog discovery and operation-argument schema validation.
- Added one-time approval IDs with expiration/single-use, project identity checks and non-overwriting project backups.
- Added AE apply flow with scoped operations, save, composition/layer readback and PNG frame proof.
- Added Premiere CEP scene import, new-sequence creation, active-sequence identity/readback, project save and optional export verification.
- Added project-path guards to Premiere CEP operations and stopped on unverified imports/saves/exports.
- Added high-level Adobe preview/apply tools to the Motion Studio MCP server.
- Scoped AE/Premiere tool authority for approved sessions; arbitrary ExtendScript and Premiere unsafe-script remain disabled.
- Added mocked end-to-end workflow tests. Real licensed-host validation remains a release gate.

## 0.3.0-alpha.1 — First executable renderer

- Added Canonical Video IR to HyperFrames/GSAP HTML composition compiler.
- Added render manager, FFprobe media validation and sampled PNG frame evidence.
- Added local Adobe MCP clients and launchers for the upstream After Effects and Premiere Pro servers.
- Added Node.js 24+ runtime baseline, package/software pinning and cross-platform Adobe application detection.
- Added 0.3 orchestration and installer design documentation.

## 0.2.0 — Installer and integration foundation

- Added cross-platform installation bootstrap for Windows, macOS and Linux.
- Added Node.js 22+ checks and user-local Node.js 26 bootstrap on macOS/Linux.
- Added npm workspace setup, HyperFrames CLI/browser preparation and optional FFmpeg/Blender installation.
- Added user-level skill staging and generic MCP configuration.
- Added Canonical Video IR validation, engine routing, typography utilities and deterministic QA.
- Added production orchestration state machine and governed skill-evolution lifecycle.
- Added FFmpeg command planning and local runtime API foundation.
- Added CI matrix for Node.js 22/24 on Ubuntu, Windows and macOS.

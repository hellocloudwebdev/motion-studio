# Changelog

## Unreleased — Harness-first creative pipeline
- Kept provider-neutral MCP planning and IR compilation independent of model credentials.
- Retained OpenRouter as an optional standalone CLI provider, defaulting to its free-model router; web search remains explicit opt-in.
- Added a no-key MCP tool-list integration test.

## 1.0.0-alpha.1 — Premiere interchange and governed sequence handoff
- Started FCPXML 1.10 export from validated editorial assembly manifests.
- Preserved rational frame timing, track lanes, source checksums and rights-review metadata in an interchange sidecar.
- Added CLI and MCP export entry points with explicit asset-root resolution and fail-closed unresolved-media handling.


## 0.9.0-alpha.1 — Editorial assembly planning
- Added deterministic frame-accurate scene and layer timeline planning with overlap-aware video, audio and graphics tracks.
- Added asset URI, checksum and rights-review propagation plus structural and handoff validation.
- Added CLI and MCP planning/validation entry points, tests and operator documentation.


## 0.8.0-alpha.1 — Media derivatives and preview artifacts
- Added safe FFmpeg/FFprobe derivative generation for video proxies, thumbnails, audio waveforms and raster-image previews.
- Added SHA-256 provenance manifests, content-derived output names, bounded process execution and no-overwrite defaults.
- Added CLI and MCP entry points plus derivative workflow documentation and integration tests.


## 0.7.0-alpha.1 — Asset intelligence and governed media intake
- Added deterministic asset scanning, path-specific IDs plus content IDs, streaming SHA-256 checksums and duplicate detection.
- Added FFprobe media metadata inspection and file-integrity verification.
- Added rights-review records with actor, license, usage scope, attribution and optional expiry.
- Added additive registry-to-IR attachment and asset identity/reference validation.
- Added CLI asset scan, verify, probe, approve-rights and attach commands.
- Added asset-library guide, milestone plan and regression tests.


## 0.6.0-alpha.1 — Verified production orchestration
- Added fail-closed host readiness evaluation for routed engines, Premiere assembly and FFmpeg delivery.
- Added project/run/stage-scoped, time-bounded approval gates before Premiere assembly and final export.
- Added per-operation Adobe MCP approvals bound to exact tool names and argument digests.
- Added CLI preflight and MCP tools for host readiness and production-stage authorization.
- Added orchestration and Adobe approval tests, plus milestone 0.6 documentation.

## 0.5.0-alpha.2 — Integrated evidence-driven visual QA
- Connected render receipts to a fail-closed QA evaluator and CLI delivery gate.
- Added FFmpeg black-frame, frozen-frame and audio-silence analysis, plus grayscale perceptual near-duplicate detection.
- Added optional Tesseract OCR, text safe-area checks and subtitle-region review notes.
- Persisted QA runs, repair history and explicit producer approvals in an enriched Canonical Video IR copy.
- Added opt-in advisory visual-critic provider contract and bounded repair plans with human escalation.
- Added synthetic MP4 integration coverage and cross-platform FFmpeg setup in CI.

## 0.3.0-alpha.1 — HyperFrames render pipeline
- Added Canonical Video IR to HyperFrames compiler and MP4 render/inspection pipeline.
- Added local Adobe MCP clients and installer configuration.

## 0.2.0 — Installer and integration foundation
- Added cross-platform installation bootstrap for Windows, macOS and Linux.
- Added Node.js 22+ checks and user-local Node.js 26 bootstrap on macOS/Linux.
- Added npm workspace setup, HyperFrames CLI/browser preparation and optional FFmpeg/Blender installation.
- Added user-level skill staging and generic MCP configuration.
- Added Canonical Video IR validation, engine routing, typography utilities and deterministic QA.
- Added production orchestration state machine and governed skill-evolution lifecycle.
- Added FFmpeg command planning and local runtime API foundation.
- Added CI matrix for Node.js 22/24 on Ubuntu, Windows and macOS.

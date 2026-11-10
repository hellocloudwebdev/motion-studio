# Motion Studio — Master remaining implementation roadmap

**Purpose:** Drive implementation against the Architecture Lock and the end-to-end production definition of done. This document is the master tracker for milestones 1.0–1.9. Update status and attach evidence in the PR that implements each item.

## Product acceptance target

A user provides a video idea; Motion Studio autonomously turns it into a professional, narrated, edited, quality-checked video with its Canonical Video IR, source project, assets, captions, provenance and delivery evidence.

## Locked production flow

Canonical Video IR → per-scene engine routing → scene rendering → specialist After Effects work where required → Premiere editorial assembly → Media Encoder / FFmpeg delivery → independent output inspection.

Keep the locked roles: HyperFrames + GSAP (programmable 2D), After Effects (specialist VFX/compositing), Premiere (editorial), Blender (3D), Three.js (procedural/WebGL 3D), FFmpeg/FFprobe (media processing and validation). DaVinci Resolve is out of scope; Remotion is optional, not a primary engine. Adobe products remain user-installed and user-licensed.

## Baseline and evidence rules

The repository already contains the Canonical Video IR, agent/orchestration foundations, installer, HyperFrames compiler/render path, asset registry, media derivatives, editorial assembly, initial Premiere FCPXML interchange, deterministic render QA, bounded-repair scaffolding and Adobe MCP governance. Retain and extend these packages.

PRs #4–#9 are a dependency chain for milestones 0.5–1.0. At the time this roadmap was created, their CI runs reported success, but they were open and CI is not production acceptance. Merge and validate in dependency order. A real licensed Adobe workstation test is a separate acceptance gate.

Use these evidence states consistently:
- **Implemented:** code exists.
- **CI verified:** automated tests pass.
- **Runtime verified:** the actual renderer/editor/software executed and returned verified artifacts.
- **Production accepted:** a complete acceptance project passed all delivery gates.

Never promote a capability to runtime-verified or production-accepted based only on mocks, package tests, or a successful command exit.

## Milestone 1.0 — Close and stabilize the existing foundation

**Goal:** Complete the 0.5–1.0 dependency chain and establish a reliable baseline.

- [x] Integrate asset registry → derivatives → editorial assembly → Premiere interchange using actual upstream outputs (local kinetic typography artifact chain recorded above).
- [x] Add golden multi-track overlap assertions for video/audio lanes, source in-points, offsets, durations and exact rational frame-rate conversion.
- [x] Test unsupported clip types, missing media, unsafe paths and unresolved sources; unsupported non-media clips block export unless explicitly approved, then remain warnings in the sidecar.
- [ ] Verify engine output metadata: dimensions, rational frame rate, duration, color space, alpha, codec and audio metadata.
- [ ] Carry project revision and source hashes across stages; reject incomplete artifacts.
- [x] Document the manual Premiere import/readback procedure and state that no release is certified until a live receipt exists.
- [ ] Import generated FCPXML on a licensed Premiere workstation and compare the imported sequence against the editorial manifest.

**Exit gate:** Validated IR → editorial manifest → valid FCPXML/sidecar → real Premiere import and sequence readback. CI alone is insufficient.

## Milestone 1.1 — Autonomous creative production pipeline

**Goal:** Connect the creative agent roles so a natural-language idea becomes a complete, render-ready Canonical Video IR.

- [ ] Production intake: audience, purpose, duration, language, platform, aspect ratio, brand rules, references and supplied assets; ask only essential clarifying questions.
- [ ] Versioned production brief schema and validation.
- [ ] Research workflow when factual claims are needed; persist source URLs, claim-level evidence, unsupported claims and media provenance/usage restrictions.
- [ ] Creative direction: concepts, selected narrative, tone, visual language, hook, message hierarchy, pacing and CTA.
- [ ] Scriptwriting: narration and on-screen copy kept separate; estimate/final frame ranges, speaking pace and scene timing.
- [ ] Storyboarding: scene purpose, duration, composition, camera, typography, animation, transitions, asset and audio cues.
- [ ] Project design system: brand tokens, typography, spacing, safe areas, motion presets, font availability and glyph coverage.
- [ ] Generate and validate Canonical Video IR from the approved brief/script/storyboard/design system.
- [ ] Version every approved production revision and preserve creative intent independently of renderer implementation.

**Deliverables:** connected creative-agent workflow, production brief/script/storyboard contracts, design-system generator, natural-language-to-IR CLI/MCP workflow and tests.

**Exit gate:** A user enters an idea and receives a complete, validated, render-ready IR without manually constructing project JSON.

## Milestone 1.2 — Production-grade HyperFrames + GSAP renderer

**Goal:** Make HyperFrames the dependable primary engine for 2D motion graphics, typography and graphical scenes.

- [ ] Layer support: rich text, shapes/vector graphics, images/video, audio, charts/data visualization, groups/composites, masks/effects, backgrounds, gradients and overlays.
- [ ] Motion: reusable presets, keyframe interpolation, easing/curves, entrance/exit/emphasis, transitions, stagger, 2D camera-like movement and deterministic arbitrary-frame seeking.
- [ ] Typography: responsive sizing, wrapping, line-height, fit-to-container, safe-area checks, font fallback/glyph checks, subtitle/lower-third components.
- [ ] Composition: reusable templates, supported nested compositions, brand components, shared tokens, consistent transitions, deterministic IDs.
- [ ] Performance: scene cache, incremental render, memory-aware scheduling, cancel/resume, progress, draft/final profiles.
- [ ] Document renderer capability limits. Unsupported content must fail or produce an explicit approval-required warning; never silently disappear or become an unapproved placeholder.

**Exit gate:** A multi-scene 2D project renders deterministically from IR with complete, verified output metadata.

## Milestone 1.3 — FFmpeg post-production and mastering

**Goal:** Produce a synchronized, verified final video from scene renders and audio/caption assets.

- [ ] Assemble scenes in exact frame order, including transitions/overlaps and mixed source formats.
- [x] Mix narration, music and SFX; align project and scene cues to the Canonical IR frame rate; support gain, fades, ducking and multiple tracks. Stems/alternate mixdown exports remain open.
- [ ] Detect clipping, silence, synchronization errors and invalid frame-rate changes.
- [ ] Generate SRT and WebVTT from approved narration; synchronize to final timing; support styled subtitle overlays and language/font handling.
- [ ] Add approved overlays, logos and end cards; normalize color, dimensions and frame rate; handle crop/letterbox per profile.
- [ ] Export 16:9, 9:16, 1:1 and custom ratios with platform codec/bitrate/audio/resolution presets.
- [ ] Probe final output with FFprobe; verify codec, duration, dimensions, frame rate, audio presence/sync and file integrity; save inspection frames.

**Exit gate:** Scene renders + narration + music + captions produce one verified MP4 matching the requested profile.

## Milestone 1.4 — After Effects, Premiere and Media Encoder production integration

**Goal:** Turn Adobe connection scaffolding into governed, verifiable workstation operations.

**After Effects**
- [ ] Verify live host connection and capabilities.
- [ ] Checkpoint/copy project before writes.
- [ ] Create editable compositions from approved scene specs; configure dimensions/frame rate.
- [ ] Import approved assets; create/modify layers; apply supported effects/animation and specialist VFX/compositing.
- [ ] Save, render, read back composition/render state and return artifact paths plus operation evidence.

**Premiere**
- [ ] Import verified scene renders and AE outputs; create/import sequences and organize tracks.
- [ ] Position clips precisely; apply supported transitions; add narration/music/SFX/captions.
- [ ] Read back sequence structure after edits; save checkpoints; export through the supported Adobe workflow.
- [ ] Independently inspect exported media.

**Governance and Media Encoder**
- [ ] Read-only by default; exact-operation approvals for writes; project/sequence scope; pre-edit checkpoints; post-edit readback.
- [ ] No blind retries after uncertain operations and no arbitrary script execution by default.
- [ ] Integrate Adobe export queue where supported; manage explicit presets and queue state; verify outputs independently; explicit approved fallback only.
- [ ] Preserve upstream mcp-aftereffects as editor-control layer; Motion Studio owns orchestration, approvals, contracts and validation.

**Exit gate:** A licensed workstation performs a real AE composition operation, Premiere sequence assembly and final export; Motion Studio reads back and verifies each result.

## Milestone 1.5 — Blender 3D renderer

- [ ] Define IR-to-Blender mapping and generate scene files.
- [ ] Create objects/meshes/materials; configure cameras/lighting; import supported assets.
- [ ] Support animation/keyframes and bounded basic particle/simulation workflows.
- [ ] Configure render engines/quality; render image sequences with alpha when required.
- [ ] Emit scene metadata and render receipts; support cancellation/resume.
- [ ] Adapt outputs to the common engine contract and integrate with Premiere assembly.

**Deliverable:** `@motion-studio/blender-adapter`, compiler, render-manager integration, asset/material mapping and fixtures.

**Exit gate:** An IR-defined 3D scene renders in Blender and is incorporated into a mixed 2D/3D production.

## Milestone 1.6 — Three.js procedural 3D renderer

- [x] Define IR-to-Three.js mapping; scene, camera and lighting systems (camera and default lighting; see [THREEJS-ADAPTER.md](THREEJS-ADAPTER.md)).
- [x] Geometry/material generation and procedural graphics for the supported primitive subset. Custom shaders and particles remain open.
- [x] Integrate GSAP where useful.
- [x] Render deterministic frame-seekable scenes through the HyperFrames browser workflow and capture frame evidence.
- [x] Validate opaque output dimensions, timing and metadata; emit a hash-bearing receipt. Alpha output remains open.

**Deliverable:** `@motion-studio/threejs-adapter`, compiler, shader/preset library, browser render integration and tests.

**Status:** Core adapter and the local 3-second runtime fixture are implemented and runtime verified on 2026-11-10 (HyperFrames lint/check/snapshot/render passed; FFprobe verified 1280×720, 30 fps, 90 frames, H.264; rendered frame visually inspected). Model imports, custom shaders, particles, alpha/image-sequence output, and mixed-scene editorial inclusion remain open.

**Exit gate:** An IR-defined procedural 3D scene renders frame-accurately and appears in a final video.

## Milestone 1.7 — Visual, audio and creative QA with bounded repair

**Technical QA**
- [ ] Schema/semantic validation, frame timing, missing media/fonts, dimensions, frame rate, codec/color, black/frozen frames, silence/clipping and file integrity.

**Visual QA**
- [ ] Text overflow/clipping, typography, contrast, safe areas, balance, alignment, spacing, continuity, transitions, flicker/flashes, duplicate/frozen content and asset correctness.

**Audio and creative QA**
- [ ] Narration/music/SFX sync, loudness, clipping/distortion, silence, intelligibility and mix balance.
- [ ] Brief/message alignment, hook, narrative progression, pacing, art direction consistency and CTA clarity.

**Repair execution**
- [ ] Defect includes evidence, exact frame/time ranges, owning scene/layer/stage and severity.
- [ ] Generate smallest valid patch; validate changed IR/project; rerender affected components only; rerun relevant checks.
- [ ] Escalate unresolved critical issues; retain repair history and regression evidence.
- [ ] Reconcile retry policy: default maximum two automatic cycles vs configurable maximum three in 0.5. Choose one documented production policy before expanding retries.
- [ ] Visual-critic output is advisory and cannot override deterministic gates.

Render-evidence QA defects now carry repair ownership and, for failed sampled-frame decodes, a one-frame integer range plus the evidence path/time. Scene/layer localization for other kinds of visual/audio findings and executable patch/retest loops remain open.

**Exit gate:** Injected defects are detected/localized; permitted repairs rerender and pass retests, otherwise the issue is explicitly escalated.

## Milestone 1.8 — Complete delivery and production packaging

- [x] Generate master and requested platform variants for supported FFmpeg container/codec profiles.
- [ ] Include captions/subtitle files, Canonical IR, editorial manifest, required source projects and only the assets actually used. Captions, source/portable IR and referenced local assets are included; editorial manifest and conditional engine project references remain open.
- [ ] Include AE/Premiere/Blender project references only when actually created.
- [x] Include asset/provenance manifests, source hashes, rights-review records, render manifest, QA report/defect history, available sampled frames, operation history, software versions and settings in the delivery package. Cross-project engine source files remain conditionally included when available.
- [x] Generate human-readable `DELIVERY-REPORT.md`.
- [x] Verify package file integrity with a SHA-256 manifest and independent verifier. Reproducible rebuild comparison remains open.

Suggested layout (include folders conditionally):
```
delivery/
  final/ master.mp4 [requested variants]
  captions/ subtitles.srt subtitles.vtt
  project/ canonical-video-ir.json editorial-assembly.json premiere-handoff.fcpxml [editor projects]
  assets/ source-manifest.json derivatives/
  evidence/ render-manifest.json qa-report.json qa-frames/ export-verification.json
  provenance/ source-hashes.json software-versions.json operation-history.json
  DELIVERY-REPORT.md
```

**Exit gate:** A successful production creates a self-describing, integrity-checked delivery package with all required source and evidence artifacts.

**Status:** Local FFmpeg integration tests create a package from a real two-second MP4, verify portable asset remapping and hashes, reject a path escape, and detect post-package tampering. Full acceptance still needs the narrated production bundle, editorial manifest/source projects, reproducibility comparison, and production-ready render evidence.

## Milestone 1.9 — Learning, portability, security and release hardening

**Learning**
- [ ] Keep project memory, user style preferences and validated reusable production patterns separate.
- [ ] Capture approved creative decisions and repair outcomes.
- [ ] Propose reusable skill/template changes; evaluate on test projects; version, approve and retain rollback metadata.
- [ ] Never silently promote code, dependencies, permissions or secrets.

**Host portability**
- [ ] Separate Z Code, Claude Code, Codex, Cursor and generic MCP adapters.
- [ ] Host-version compatibility checks and independent capability tests.
- [ ] Configuration-preserving install/remove; do not assume a shared manifest lifecycle.

**Installer/software doctor**
- [ ] Fresh Windows/macOS/Linux setup; dependency/version, disk/memory, FFmpeg/browser, Blender, Adobe and MCP health checks.
- [ ] Repairable diagnostics, safe upgrade/uninstall and machine-readable report.
- [ ] Adobe apps are user-installed/user-licensed; guide setup but never bypass sign-in, subscription or activation.

**Security/reliability**
- [x] Local-first, loopback-only protected runtime and authenticated operations (runtime test verifies loopback endpoint, bearer auth, payload limit and strong-token requirement). Secure token storage integration remains open.
- [ ] Allowlisted process execution, workspace path restrictions, untrusted media/prompt-injection protections.
- [ ] Checkpoints, approval/audit records, resource-aware scheduling, safe cancellation/recovery.
- [ ] No arbitrary Adobe scripts by default.

**Release**
- [ ] Windows/macOS/Linux CI, supported Node matrix, unit/integration and real-media fixture tests.
- [ ] Installer upgrade/uninstall tests, live Adobe workstation receipts, engine compatibility matrix, release notes and migration docs.

**Exit gate:** Clean install configures the open-source pipeline, user-configured editor integrations work, productions are verifiable, and uninstall preserves user software/data.

## Mandatory end-to-end acceptance projects

1. **Startup advertisement (15–30s):** brand motion graphics, product visuals, animated text, music and CTA.
2. **Kinetic typography:** narration-driven text animation, transitions, exact timing and safe-area checks.
3. **Narrated explainer:** research-backed script, narration, graphics, subtitles, music and final mix.
4. **Data visualization:** animated charts, source evidence, transitions and visual hierarchy.
5. **Mixed 2D/3D production:** HyperFrames plus Blender or Three.js, AE compositing and Premiere editorial assembly.

Each applicable project must produce a final MP4, Canonical IR, script/storyboard, required source projects, asset/provenance manifests, captions, render/export receipts, QA report, sampled-frame evidence and reproducible configuration.

## Global definition of done

- [ ] Natural-language idea → valid production brief.
- [ ] Research evidence, script, storyboard and design system.
- [ ] Versioned, validated Canonical Video IR.
- [ ] Hashed, traceable assets and explicit rights review.
- [ ] Engine routing based on verified capabilities.
- [ ] Real HyperFrames, After Effects, Premiere, Blender and Three.js outputs.
- [ ] Synchronized narration, music, SFX and captions.
- [ ] Technical, visual, audio and creative QA evidence.
- [ ] Bounded repair with retests and escalation.
- [ ] Verified master and requested variants.
- [ ] Provenance, operation and tool-version records.
- [ ] Fresh-machine install, security and host-portability acceptance.

## Explicit non-goals / architecture boundaries

Do not replace HyperFrames with Remotion as primary renderer; do not add DaVinci Resolve as primary target; do not fork creative cores by AI host; do not silently install/activate licensed Adobe products; do not edit .aep/.prproj as opaque binaries; do not allow silent agent changes to code/permissions/dependencies; do not equate successful render command with delivery; do not treat checksums or producer rights records as legal clearance; do not enable cloud rendering or autonomous publishing without a separate architecture decision.

## Execution and PR rules

Every milestone requires a dedicated branch and PR, written scope/checklist, package and CLI/MCP tests, regression tests, cross-platform CI where applicable, real runtime evidence for render/editor capabilities, updated architecture/operator docs, and a completed/deferred/blocked list. Do not merge or declare completion solely because code exists.

## Current tracker

Updated 2026-11-10 after local integration on `main`. The automated suite reports 118 passing tests and one environment-dependent symlink test skipped; `npm audit --omit=dev` reports zero vulnerabilities. These are not cross-platform CI, host runtime verification of unavailable software, or production acceptance.

Runtime evidence: a clean HyperFrames compile/lint/check/snapshot/render and verified FFmpeg delivery passed for the 4-second kinetic typography fixture (`projects/kinetic-type-demo/deliverables/delivery-receipt.json`). The Three.js demo also passes browser render and independent FFprobe checks, and delivery packaging tests exercise local FFmpeg media. These are narrow technical samples, not narrated production acceptance.

The rendered MP4 was also scanned and checksum-verified into the asset registry, attached to a derived Canonical Video IR, converted into an editorial assembly, and exported to FCPXML with its provenance sidecar. The assembly correctly retained an unapproved-rights warning. The interchange has not been imported/read back in Premiere.

| Milestone | Current evidence status | Remaining acceptance evidence |
|---|---|---|
| 0.5–0.9 | Integrated locally; unit/CLI coverage passes | Fresh combined CI on supported platforms; run real asset → derivative → editorial → interchange chain |
| 1.0 | FCPXML exporter, provenance sidecar, multi-track overlap/rational-time golden assertions, and fail-closed safety tests implemented; CLI requires `--allow-unsupported` for intentionally incomplete XML | Live import and readback comparison in licensed Premiere; publish a version compatibility record from that evidence |
| 1.1 | Provider-neutral MCP stages and optional OpenRouter Responses API CLI adapter with free-model default and structured output implemented; MCP tools verified without a model key; offline tests pass | Complete host-harness idea-to-IR acceptance and revision lineage; source-grounded web research remains explicit opt-in because search can cost extra; standalone live-model testing is optional |
| 1.2 | Chart rendering, motion timing, CSS sanitization and typography warnings implemented | Broader layer/template/cache/cancel-resume support and deterministic multi-scene renderer runtime acceptance |
| 1.3 | FFmpeg integration test creates a real H.264 master with two audio tracks, frame-derived offsets, gain, trims, fades and narration side-chain ducking; FFprobe verifies dimensions/audio/duration | Speech intelligibility/loudness QA, caption synchronization against produced speech, stem exports, and full narrated acceptance package |
| 1.4 | Governed Adobe MCP client and host readiness/approval gates implemented | Real licensed After Effects, Premiere and Media Encoder operations with checkpoint/readback/export receipts |
| 1.5 | Blender scene contract/adapter foundation implemented | Blender runtime render and mixed-scene acceptance on supported hosts |
| 1.6 | Three.js adapter, CLI/MCP render operation and local runtime fixture implemented; HyperFrames lint/check/snapshot/render and FFprobe verification passed | Broader shader/particle/model/alpha support and mixed-scene editorial acceptance |
| 1.7 | Structured render QA, advisory critic and bounded repair planning implemented | Defect-to-patch execution, affected render, retest and multimodal acceptance evidence |
| 1.8 | Master/profile transcodes, captions, source and portable IR, referenced-asset packaging, editorial/render/QA/operation/software evidence, available QA frames, human report and SHA-256 integrity verification implemented; local FFmpeg integration cases pass, including traversal/tamper rejection | Narrated production package; engine source project references, production-ready render evidence and reproducible rebuild comparison |
| 1.9 | Installer and host process safety foundation; local runtime now requires a >=32-byte bearer token and uses constant-time comparisons, covered by loopback HTTP integration tests | Secure OS-backed token storage, fresh Windows/macOS/Linux install, upgrade/uninstall, host matrix, recovery and security acceptance |

No milestone is marked production-accepted by this integration. A passing automated test suite does not replace actual renderer/editor execution or the five end-to-end acceptance projects.

**Status discipline:** Update this table only when evidence is attached. CI success is not runtime verification; runtime verification is not production acceptance. The current environment has no Blender or Adobe desktop applications, so their runtime exit gates remain open.

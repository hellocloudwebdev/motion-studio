# Motion Studio — Master remaining implementation roadmap

**Purpose:** Drive implementation against the Architecture Lock and the end-to-end production definition of done. This document is the master tracker for milestones 1.0–1.9. Update status and attach evidence in the PR that implements each item.

## Product acceptance target

A user provides a video idea; Motion Studio autonomously turns it into a professional, narrated, edited, quality-checked video with its Canonical Video IR, source project, assets, captions, provenance and delivery evidence.

## Locked production flow

Canonical Video IR → per-scene engine routing → scene rendering → specialist After Effects work where required → Premiere editorial assembly → Media Encoder / FFmpeg delivery → independent output inspection.

Keep the locked roles: HyperFrames + GSAP (programmable 2D), After Effects (specialist VFX/compositing), Premiere (editorial), Blender (3D), Three.js (procedural/WebGL 3D), FFmpeg/FFprobe (media processing and validation). DaVinci Resolve is out of scope; Remotion is optional, not a primary engine. Adobe products remain user-installed and user-licensed.

## Baseline and evidence rules

The repository already contains the Canonical Video IR, agent/orchestration foundations, installer, HyperFrames compiler/render path, asset registry, media derivatives, editorial assembly, initial Premiere FCPXML interchange, deterministic render QA, bounded-repair scaffolding and Adobe MCP governance. Retain and extend these packages.

PRs #4–#9 were the dependency chain for milestones 0.5–1.0; their work is integrated in the current `main` baseline. Revalidate the combined chain in CI and on target hosts. A real licensed Adobe workstation test remains a separate acceptance gate.

Use these evidence states consistently:
- **Implemented:** code exists.
- **CI verified:** automated tests pass.
- **Runtime verified:** the actual renderer/editor/software executed and returned verified artifacts.
- **Production accepted:** a complete acceptance project passed all delivery gates.

Never promote a capability to runtime-verified or production-accepted based only on mocks, package tests, or a successful command exit.

### Progress evidence update — 2026-11-10

- Local offline narration is implemented through fixed platform speech executables (Windows SAPI, macOS `say`, Linux `espeak`). `narration-generate` verifies WAV/audio output with FFprobe, writes project-scoped assets and narration cues, derives captions from measured segment timing, and flags rights review as required. A Windows runtime test generated a verified speech file.
- An 18-second three-scene narrated fixture was generated and its HyperFrames snapshots visually show the intended scenes. HyperFrames' pre-render check reports a zero-size composition root (`sweep_static`), so the render manager correctly stopped before MP4 export. This is not narrated render acceptance.
- Latest automated suite at this update: 127 passed, 0 failed, 1 skipped. Three.js runtime acceptance is available locally; Blender and licensed Adobe workstation acceptance remain external gates.

### Progress evidence update — 2026-11-11

- Added the explicit, bounded `float` motion preset for IR-selected scene motion and sized compositions from the canonical canvas. The narrated fixture now passes all nine HyperFrames seek/layout samples; the check remains enabled.
- Rendered an 18-second 1280×720, 30 fps H.264 scene master with no black/frozen-frame or sampled perceptual-duplicate findings. FFmpeg then mixed the generated narration into a verified H.264/AAC delivery variant and generated SRT/VTT; package integrity verified 19 files.
- Offline speech generation now trims trailing silence while retaining internal phrase pauses; approved script segments may specify integer-frame lead-ins. The final mixed-audio analysis reports no silence events for the fixture.
- Delivery acceptance remains correctly pending because the generated system voice has `rightsStatus: unknown`. No licensed music/SFX or human speech/creative approval is recorded.
- Latest automated suite: 128 passed, 0 failed, 1 skipped; `npm audit --omit=dev` reports zero vulnerabilities.

### Progress evidence update — 2026-11-12

All work below ran on this Windows host (Node 24, HyperFrames 0.8.86, FFmpeg 9.0.2).

- P1.3 repair execution implemented: `packages/core/src/patch.mjs` adds a schema-validated IR patch envelope with CAS on the IR hash, six whitelisted op types (`set_typography`, `set_transform`, `set_motion`, `set_timing`, `rebind_asset`, `set_audio_cue`), a no-new-issues rule on apply, `classifyDefects`/`createPatchFromDefects` and a cumulative ±6 dB gain budget per runId. Design record: `docs/DESIGN-REPAIR-EXECUTION.md` (decision table, 6-op patch model, 76-code defect→repair registry, hybrid targeted rerender, run persistence, single policy source).
- Render QA media findings (black/freeze/silence/loudness/perceptual-duplicate/OCR families) now become structured defects with integer `timeRangeFrames`, scene attribution, evidence path and repair owner (audio-producer / typography-specialist / technical-qa) instead of collapsing to `{code,message}` (`packages/core/src/frame-time.mjs`).
- Orchestrator: `loadQualityGates()` makes `configs/quality-gates.json` the single authoritative repair policy (maxCycles=2, hard ceiling 3), resolving the roadmap's 2-vs-3 retry-policy conflict; `run-state.mjs` persists `projects/<id>/run-state.json` with resume-from-verified-artifact and input-hash invalidation; the IR `repairHistory` ledger is the authoritative cycle count.
- Render-manager: `manifest.sceneTimeline`; scoped per-scene rendering via HyperFrames `render --composition scenes/<id>.html` into `renders/<label>/segments/` with scoped checks and time-shifted media analysis; `throwOnQaFailure`/`renderLabel` options; repair renders force `allowMissingAssetsAsPlaceholders:false`.
- New `packages/repair-executor` (`@motion-studio/repair-executor`) implements `runRepairLoop`/`executeRepairCycle`: defect → classify → patch → CAS-apply → backup (`history/revision-*.json`) → atomic IR write → scoped-or-full render → retest (including mixed-segment audio retests via `audioInputsFromProjectRange`) → master refresh → escalate; escalation reports (JSON + markdown) in `projects/<id>/escalations/`; 20-minute render bound; dry-run; exit contracts 0/3/1. CLI: `motion-studio repair` with `--max-cycles`/`--no-targeted`/`--quality`/`--dry-run`/`--project-root`.
- Segment/full consistency probe (real renders, 2 scenes × 2 s): per-frame mean-absolute-difference max 0.075 / mean 0.058 vs thresholds ≤1.25 / ≤0.5 — targeted scene renders are frame-consistent with the full master; the whole-project fallback is retained for policy/attribution/runtime-failure cases.
- Integration tests cover the injected-defect exit-gate scenario, the no-candidate-asset escalation (exit 3, zero consumed cycles), ±6 dB budget exhaustion, frame-decode single-retry-then-escalate, dry-run behavior, and resume/invalidation. A code review pass found and fixed one P0 (scene-local cue offsets vs project-timeline ranges), three P1s (severity gating, single-patch budget overspend, id-derived path escapes) and two P2s; two findings remain deferred and recorded in the design doc.
- P1.4 first advertisement implemented: `templates/startup-ad/project.json` rewritten as `startup-ad-acceptance-24s` — 24 s (720 frames @30 fps, 1920×1080), 4 scenes (hook → product reveal → chart how-it-works → CTA), all layers text/shape/chart (HyperFrames-only, zero external assets), safe areas on, font specified on all text layers, bounded float motion presets, brand tokens, `production.script` with 4 narration segments (`leadInFrames 12`), delivery target master-16x9 (mp4/H.264/AAC, audioRequired). Invented neutral product ("Gridsense" smart home energy monitor); no third-party brand or media.
- Provider-backed speech (P3.1): `packages/speech-adapter/src/fish-audio.mjs` implements the Fish Audio TTS provider (`POST api.fish.audio/v1/tts`, model via request header, default `s2.1-pro-free`, `reference_id` voice selection, prosody speed, wav output, FFprobe verify + shared trailing-silence trim, workspace containment, injectable fetch). CLI `narration-generate --speech-provider fish-audio --speech-voice <id> --speech-speed <0.5-2>`. Provider terms recorded honestly; `rightsStatus` stays unknown pending producer review. Live API verified with a user-supplied key (stored only in gitignored `.env.local`); docs in `docs/SPEECH-PROVIDERS.md`.
- **P1.4 ACCEPTED — the project's first production-accepted delivery**: the 24 s ad was re-narrated with Fish Audio voice `933563129e564b19a115bedd57b7406a` ("Sarah", 0.95× prosody; segments 4.32/4.00/3.96/3.36 s, all FFprobe-verified), three locally synthesized FFmpeg SFX (whoosh/shimmer/pop, `rightsStatus generated`, no third-party material) were attached as scene cues, the producer approved the final audio after listening to the delivered master, and rights were recorded on all 7 audio assets (`rightsStatus cleared` with a full `rightsApproval` audit record). Final flow: `motion-studio repair` (no-action, re-render on IR-hash change) → `deliver` → receipt `status: "accepted"`, 24-file package, integrity 24/24, delivered-variant media analysis 0 findings, master `startup-ad-acceptance-24s-master-16x9.mp4` (24.000 s, H.264 1920×1080 + AAC) verified. This closes the P1.4 exit gate on the local supported path.
- Latest automated suite at this update (local suite; remote CI has not run): 224 tests, 223 passed, 0 failed, 1 environment-dependent skip, up from 131/0/1 at the 2026-11-11 baseline.

### Progress evidence update — 2026-11-12 (second session)

- Blender 5.3.0 installed via winget on this host. First-ever real Blender render exposed two latent driver bugs (the adapter had never been runtime-verified): Blender 5.3 exposes only the `BLENDER_EEVEE` engine id (adapter now resolves the engine id dynamically) and no longer substitutes `#` frame placeholders on `write_still`, which silently overwrote one PNG for all 24 frames (driver now writes explicit zero-padded `frame_NNNN.png`). Adapter gained an integer `threads` cap for low-power hosts.
- **Blender runtime acceptance (first real render receipt)**: `projects/blender-smoke` — IR-defined 1-scene, 1-primitive fixture at 480×270, 24 frames @30 fps rendered with EEVEE on Blender 5.3.0, `--threads 2` (low-power profile, ~66 s, host remained responsive). Receipt `verified: true` with frame count 24/24, FFprobe-confirmed 480×270 dimensions, frame-evidence digest, actual renderer id and Blender version recorded. Runtime-verified single-scene evidence; camera-move/lighting/imported-asset fixtures, failed-frame recovery, alpha output and mixed-scene editorial inclusion remain open per P2.1–P2.3.
- A `git reset --hard` during branch rewiring reverted five uncommitted files (speech-adapter index exports, Blender fixes, template, `.env.example`, roadmap updates); all were reconstructed from session evidence, the full suite re-verified green (224/223/0/1), and the branch commits redone. Committed on `feat/phase1-repair-executor-fish-audio`.
- **Mixed 2D/3D production path implemented and proven (Phase-2 P2.3 path)**: `packages/ffmpeg` gained `buildSceneAssemblyPlan`/`assembleScenes` (concat-demuxer assembly, fail-closed segment verification for missing/dimension/rational-fps/duration mismatches, post-encode master verification; paths reject line-break control characters after a review found a concat-list injection vector); `packages/render-manager/src/mixed-render.mjs` adds `renderMixedProject` (per-scene engine routing → HyperFrames scoped segments / Blender EEVEE PNG sequences → deterministic segment encodes → per-scene QA with timeline-shifted findings → assembly in IR order → receipt with documented limitations); CLI `motion-studio render-mixed`. **Runtime evidence**: a 3-scene mixed master (2 HyperFrames + 1 Blender EEVEE scene, 180 frames, 640×360, 30 fps, threads capped at 2) was rendered, assembled and independently FFprobe-verified on this host (Blender segment ≈5.2 min on the low-power profile); a 2D control render proved the standard path unaffected; suite 234/233/0/1. A review of the new path found and fixed one injection vector; remaining open: single-scene multi-engine compositing, explicit scene start offsets in assembly, audio mixing into assembled masters (currently delivery-time), alpha output.
- Deferred review findings from the repair-loop design are closed: rights vocabulary unified (delivery accepts registry `approved`), label-scoped render sidecars, stable content-derived media defect ids. Suite at this update: 234 tests, 233 passed, 0 failed, 1 environment-dependent skip.

## Detailed execution plan mapped to the four architecture phases

This section turns the attached Z Code architecture recommendation into sequenced, reviewable work. The existing milestone checklists below remain the technical detail. A work package is complete only when its listed evidence is checked in or attached to the release record. "Implemented" and "runtime verified" are separate states.

### Phase 1 — Foundation: one accepted 2D narrated production

**Outcome:** A user idea becomes a rights-reviewed, narrated 2D video with a verified master, captions, source IR, QA evidence and portable delivery.

**P1.1 — Clear the multi-scene HyperFrames render gate (P0)**
- Reproduce the 18-second narrated fixture failure with pinned HyperFrames version and preserve the check JSON, generated HTML, seek samples and environment details.
- Identify why the composition root receives a zero-sized bounding box during `check`; changing canvas CSS dimensions alone did not clear the finding.
- Fix the generated composition/seek contract or upstream-compatible integration. Do not suppress `sweep_static` or mark a failed check green.
- Add a regression fixture with multiple scene boundaries and at least one cue beginning in each scene. Verify arbitrary-time seeks and nonzero root bounds at every sampled time.
- **Exit evidence:** compile, lint, runtime/layout check, snapshots and FFmpeg render succeed; FFprobe matches IR canvas, rational FPS, frame duration and audio requirement; decoded QA frames are nonempty; the accepted check report contains no error.

**P1.1 status (2026-11-11):** The original false-positive `sweep_static` on the narrated fixture is cleared locally with the `float` scene-motion preset and explicit IR canvas dimensions. All nine HyperFrames seek/layout samples now pass on HyperFrames 0.8.86. The 18-second video render, deterministic visual render QA, audio mix, SRT/VTT generation, FFprobe profile checks and package integrity checks pass. Producer acceptance remains pending: the generated narration asset is rights-unknown, the sample has a measured 2.77-second narration gap, and music/SFX and human speech review are absent.

The `sweep_static` finding used a zero-size sentinel bbox when every sampled element geometry/opacity signature was identical; the root composition itself was not actually zero-sized. Scene cuts changed text/colors but those changes were outside the check's geometry fingerprint. An explicit scene-duration `float` motion preset makes authored movement visible to the seek check without suppressing it.

**P1.1/P1.2 current status (2026-11-11):** All nine HyperFrames seek/layout samples pass; the final 18-second render and audio-mixed delivery variant pass their visual/audio analysis, FFprobe profile checks, caption generation and 19-file integrity verification. Trailing system-voice padding is trimmed and the sample script uses frame-based narration lead-ins. The package remains pending only because voice rights are unknown and licensed music/SFX plus human speech/creative review have not been supplied.

**P1.2 — Complete the narrated audio and caption path**
- Retain offline SAPI/`say`/`espeak` as optional local speech backends; make provider choice, voice, locale, speaking rate and provenance explicit when supported by the host.
- Measure generated speech; align it to scene/frame ranges; reject overflow and preserve authorized cue offsets when projects are regenerated.
- Generate SRT and WebVTT from approved caption text and final integer-frame timing; delivery now rejects out-of-project ranges, malformed Unicode/control text and timings that cannot be represented at millisecond precision, and records the validation summary in its receipt. Reviewed-word accuracy and human synchronization review remain open.
- Attach approved music/SFX assets only after source, license and usage scope are recorded. Exercise gain, fades and narration ducking in a final render.
- Record integrated loudness and true-peak measurements from the final audio stream, alongside silence findings; flag configurable delivery-limit violations. Keep human review visible for clipping/distortion detail, speech/music synchronization, intelligibility and rights.
- **Exit evidence:** the narrated acceptance project has audible, intelligible speech; captions match reviewed words and timing; FFprobe and audio QA pass; unapproved rights remain a blocking or explicit review state.

**P1.3 — Close bounded visual/audio repair and delivery**
- Turn each critical QA finding into a defect with severity, evidence, integer-frame range, owning scene/layer and repair owner.
- Execute only bounded, schema-validated patches; rerender affected scenes; rerun the failed check and nearby regression samples; escalate after the documented retry limit.
- Include the editorial manifest, canonical source, referenced assets, caption sidecars, render/operation receipts, QA defects, inspection frames and integrity hashes in the package.
- Record output settings and compare a repeat build for deterministic metadata/content where exact pixel identity is not guaranteed.
- **Exit evidence:** tamper/missing-file checks reject a damaged package; a clean package independently verifies and contains every required source/evidence item.

**P1.3 status (2026-11-12):** implemented and locally verified: defects carry integer-frame ranges, scene attribution and owners; the bounded patch→rerender→retest loop with escalation runs via `motion-studio repair`; `configs/quality-gates.json` is the single policy source (2 cycles, ceiling 3); the segment/full consistency probe passes; the P1.3 exit-evidence items (schema-validated patches, affected-scene rerender, retests, escalation reports, tamper/missing-file rejection) are met. Remaining: host-harness production acceptance of the full loop on a narrated defect case.

**P1.4 — Complete the first advertisement acceptance**
- Produce one 15–30 second startup/product advertisement from a brief, including hook, message, CTA, design system, generated/approved assets, music and one requested profile.
- Require explicit rights review and inspect the actual master, not only snapshots.
- **Phase 1 exit:** the end-to-end advertisement and narrated explainer meet the global definition of done on the local supported path; acceptance records include the IR, script/storyboard, source/asset manifests, captions, reports and verified master.

### Phase 2 — Advanced production: verified mixed 2D and 3D

**Outcome:** At least one canonical scene rendered by Blender is combined with HyperFrames/Three.js material in a final, inspected production.

**P2.1 — Expand the Blender scene contract**
- Define supported canonical mappings for meshes/primitives, materials, camera, lighting, transforms, integer-frame animation and alpha requirements; reject unsupported features explicitly.
- Add deterministic fixtures for camera move, lighting/material variations, imported approved asset, and cancellation/error behavior. Keep local rendering concurrency at one.
- **Status (2026-11-14): DONE, runtime verified on Blender 5.3.0.** Camera keyframes (validated, auto-aim), lighting rig overrides (area/point/sun, ≤8 lights, validated ranges), material params (metallic/roughness/emission), imported .glb/.gltf/.obj assets (containment + no-symlink checks; glTF quaternion rotation-mode bug found and fixed with decoded-frame MD5 regression guards), failed-frame single retry then explicit error, AbortSignal cancellation, RGBA alpha output. Four fixtures runtime-verified (~1.7 s/frame at 480×270 threads 2); unsupported features rejected with explicit errors (full table in the adapter).

**P2.2 — Run Blender on a supported host**
- Install or provision a supported Blender version on an authorized machine; record OS, Blender/build version, render engine, fonts, hardware and settings.
- Execute actual frame-sequence renders; verify expected frame count, dimensions, alpha, color and hashes from returned artifacts.
- Exercise recovery from a failed frame without accepting incomplete output.

**P2.3 — Complete mixed-scene editorial acceptance**
- Route a 3D scene through the Blender adapter and 2D scenes through HyperFrames/Three.js using the same IR timing and provenance.
- Assemble using the locked editorial owner (Premiere for editorial assembly where the Adobe path is available; FFmpeg for the approved open-source delivery path).
- Inspect scene boundaries, color/alpha integration, sync and final output metadata.
- **Phase 2 exit:** a verified Blender receipt and mixed 2D/3D delivery package pass all relevant QA. Adapter tests alone do not close this phase.
- **Status (2026-11-13): Phase 2 EXIT MET** — P2.2 (Blender 5.3.0 runtime receipts) and P2.3 (mixed 2D/3D production `mixed-2d3d-acceptance` ACCEPTED: Blender EEVEE scene + 2 HyperFrames scenes, 14/14 integrity) are closed. Remaining open items are capability extensions (single-scene multi-engine compositing, explicit scene start offsets in assembly), not exit gates.

### Phase 3 — Production intelligence: broader inputs and automatic improvement

**Outcome:** The same controlled pipeline can produce multiple video categories and formats, while preserving asset rights, source evidence and bounded repair.

**Phase 3 status (2026-11-14):** P3.1 (provider contracts + local synth providers + OpenRouter image provider), P3.2 (real-footage ingest/trims/editorial in-points; directed narration partial), P3.3 (multi-format delivery + audio-reactive graphics) implemented and locally verified. P3.4 (creative critique wired to the repair loop) remains the open Phase-3 item; true reflow and video/stock providers remain open sub-items.
**P3.1 — Add provider-neutral asset production/acquisition**
- Define capability contracts for image, video/stock, music, SFX and speech providers; keep API credentials outside project artifacts and logs.
- Implement providers incrementally, record prompt/source, model/provider, hash, license/usage terms and approval state, and make unlicensed or unknown-rights assets non-final by default.
- Keep MCP planning usable under a host harness without forcing a Motion Studio model key; external research/search costs remain explicit and opt-in.
- **Status (2026-11-14): implemented** — new `packages/asset-providers` defines the capability contracts with deterministic local providers (SFX synth: whoosh/shimmer/pop/riser/impact/thud; music beds: key/bpm/mood chord progressions; gradient images) — all `rightsStatus: generated`, FFprobe-verified, byte-deterministic; OpenRouter image provider implemented (13 image-output models verified present, default `google/gemini-2.5-flash-image`, contract-tested with injectable fetch, live call pending spend opt-in); `attachProviderReceipt` makes unknown-rights assets non-final by default. Speech providers pre-exist in `packages/speech-adapter`. Video/stock slots mapped, no generator yet.

**P3.2 — Add directed narration and real-footage editing**
- Extend script-to-voice direction (voice/locale/pace/pronunciation) and timing review with provider-independent metadata.
- Support footage ingest, probe, proxy/derivative and frame-accurate trims while treating media metadata and embedded text as untrusted input.
- Verify source in-points, frame rate conversion, audio sync, rights and editorial manifest against rendered output.
- **Status (2026-11-14): real-footage path DONE** — `ingestFootage` (rational fps, decoded frame count, half-res proxy, thumbnail, waveform, untrusted-metadata validators) and `trimFootage` (exact-frame cuts fail-closed on range, output frame count verified) in `packages/media-derivatives`; editorial assembly resolves `{sourceAssetId, inFrame, durationFrames}` with explicit finding codes; fixture flow PSNR-verifies in-points at ~50 dB. Directed narration: voice selection + prosody speed done; pronunciation/locale remain.
- Define deterministic audio-analysis inputs and frame-bound outputs before adding audio-reactive graphics.
- Produce 16:9, 9:16, 1:1 and custom profiles from the same canonical project; reflow/reposition typography and graphics rather than merely crop where a profile requires layout changes.
- Verify each output’s codec, dimensions, rational frame rate, duration, captions, safe area and audio.
- **Status (2026-11-13): multi-ratio delivery in progress.** Done: `delivery.targets` accepts multiple targets with distinct canvas dimensions and a validated per-target `fit` mode (`contain` default, `cover`, `stretch`); delivery-manager transcodes, media-analyzes and integrity-verifies one variant per target from the same canonical IR, and `startup-ad-acceptance-24s` delivers accepted 16:9 / 9:16 / 1:1 variants (contain = scale-to-fit with black pad bars, no distortion). Remaining: true per-profile reflow — typography and graphics are currently pad-barred, not repositioned/rescaled per profile (recorded as `layout-reflow-pending` limitations in the delivery receipt), plus custom profiles beyond the three fixed ratios and per-profile safe-area verification.
- **Status (2026-11-14): audio-reactive DONE.** `analyzeAudioEnvelope` (packages/ffmpeg) produces deterministic frame-bound RMS envelopes (asetnsamples + astats, byte-identical JSON verified, silence floored at −60 dB, amovie quoting handled via the subtitle-filter convention with loud failure); chart layers bind via `content.audioEnvelope` with containment, normalization, downsampling cap and explicit `AUDIO_ENVELOPE_*` warnings; demo compiles 60 envelope-derived bars with zero warnings (`projects/audio-reactive-demo`).

**P3.4 — Complete advanced creative critique and repair**
- Evaluate brief/message alignment, hook, pacing, continuity, art direction and CTA using structured advisory findings tied to evidence and time ranges.
- Distinguish subjective review from hard deterministic gates; never allow an AI critic to waive rights, timing, media integrity or renderer checks.
- Run the bounded targeted repair/retest loop from P1.3 against visual, audio and creative defects.
- **Phase 3 exit:** at least the advertisement, kinetic typography, narrated explainer and data-visualization acceptance projects pass in their requested formats, with reviewable evidence and no silent unresolved critical findings.

### Phase 4 — Production platform: reliable repeatable operation

**Outcome:** Teams can maintain, resume and operate projects across supported hosts without losing provenance or weakening security.

**P4.1 — Resumable local orchestration and reusable systems**
- Persist stage state, inputs/outputs, approvals, checkpoints, retry count and logs per project; resume only from verified artifacts and invalidate downstream work when an input hash changes.
- Keep a single local render worker by default; make resource scheduling/cancel behavior observable and safe.
- Version reusable brand systems, templates and motion components with explicit approval, compatibility, migration and rollback metadata.

**P4.2 — Portability, host adapters and secure operations**
- Verify fresh install, upgrade, uninstall and recovery on supported Windows/macOS/Linux combinations; preserve project data and user-owned software/configuration.
- Test host adapters and MCP capabilities independently; publish a compatibility matrix instead of assuming similar host behavior.
- Validate fixed executables/argument arrays, workspace path boundaries, untrusted media handling, credential storage, approval scope and audit records.
- Treat cloud/distributed rendering as optional; define its artifact identity, access control, cost/resource limits and cancellation before enabling it.

**P4.3 — Release and operations evidence**
- Establish CI for supported Node/platform combinations, unit/integration/real-media fixtures, installer lifecycle and dependency audit.
- Maintain benchmarks for representative durations/resolutions and memory use; publish results with machine and settings context.
- Track production failures, repair rates, render cost/time and accepted outputs without collecting secrets or unapproved media.
- **Phase 4 exit:** clean-install release produces reproducible, auditable deliveries on the supported matrix and safely upgrades/recovers without data loss.
- **Status (2026-11-14): CI configured** (`.github/workflows/ci.yml`, 3-OS × Node 24, per-OS ffmpeg installs — first Actions run pending), benchmarks implemented (`scripts/benchmark.mjs` → `work/benchmark-results.json` with machine context), doctor expanded (credential presence, HyperFrames browser, benchmark results). Installer lifecycle tests and failure tracking remain open.

**Optional integrations:** Remotion remains a future specialist adapter; DaVinci Resolve remains optional finishing. Neither is a prerequisite for the four phase exit gates. Do not add distributed rendering before the local acceptance pipeline is stable.

### Cross-phase acceptance status

| Acceptance project | Current state | Required closeout |
|---|---|---|
| Startup/product advertisement | **ACCEPTED 2026-11-12**: 24 s ad (startup-ad-acceptance-24s) — Fish Audio narration + synthesized SFX, rights recorded, receipt `accepted`, 24-file package verified 24/24, 0 media findings | Maintain: none blocking; re-use as the reference acceptance run |
| Kinetic typography | **ACCEPTED 2026-11-13** (kinetic-type-acceptance): 18 s narration-driven piece, Fish Audio narration, 21/21 package after producer voice review | Maintain: none blocking |
| Narrated explainer | **ACCEPTED 2026-11-13** (offline-narrated-explainer-18s-fish): Fish Audio narration chosen by producer review over the SAPI version, 19/19 package | Maintain: none blocking |
| Data visualization | **ACCEPTED 2026-11-13** (data-viz-acceptance): 19 s IRENA-sourced renewable-capacity charts with provenance, silent master, 15/15 integrity, 0 media findings | Maintain: none blocking |
| Mixed 2D/3D | **ACCEPTED 2026-11-13** (mixed-2d3d-acceptance): Blender 5.3.0 EEVEE scene + 2 HyperFrames scenes assembled and delivered, 14/14 integrity | Single-scene multi-engine compositing and explicit start offsets remain open (audio-in-assembly and alpha now implemented) |

### Dependency and status rules

1. Close the Phase 1 renderer and narrated delivery gates before broadening provider or platform scope.
2. Run Adobe workstation operations only on a licensed, configured host with exact-operation approval and readback; an unavailable workstation is an external gate, not a reason to claim completion.
3. Run Blender runtime acceptance on a host that has Blender installed; retain the emitted render receipt and inspect actual frames.
4. Re-run the full local suite and dependency audit after each package change; update test counts and this tracker in the same change.
5. Mark each work package **implemented**, **CI verified**, **runtime verified**, or **production accepted** only at the evidence level actually achieved. Record a blocker with its owner and required host/input when progress depends on external setup.

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
- [x] Create objects/meshes/materials; configure cameras/lighting; import supported assets. (objects/materials/camera/two-point lighting runtime verified 2026-11-12 on Blender 5.3.0; imported assets remain open)
- [ ] Support animation/keyframes and bounded basic particle/simulation workflows. (integer-frame transform keyframes runtime verified; particles/simulations open)
- [ ] Configure render engines/quality; render image sequences with alpha when required. (EEVEE sequence render runtime verified 2026-11-12; alpha and quality profiles untested)
- [x] Emit scene metadata and render receipts; support cancellation/resume. (first real receipt 2026-11-12: verified frame count, FFprobe dimensions, digest, renderer id, Blender version; AbortSignal cancellation supported; resume open)
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
- [x] Defect includes evidence, exact frame/time ranges, owning scene/layer/stage and severity. (integer frame ranges + scene attribution + owners, 2026-11-12)
- [x] Generate smallest valid patch; validate changed IR/project; rerender affected components only; rerun relevant checks. (repair-executor + scoped renders, consistency probe passed)
- [x] Escalate unresolved critical issues; retain repair history and regression evidence. (escalation reports JSON+MD; IR ledger + run-state)
- [x] Reconcile retry policy: default maximum two automatic cycles vs configurable maximum three in 0.5. Choose one documented production policy before expanding retries. (2 = authoritative default from configs/quality-gates.json, implementation ceiling 3, documented in docs/DESIGN-REPAIR-EXECUTION.md §5)
- [ ] Visual-critic output is advisory and cannot override deterministic gates.

Repair-evidence QA defects carry integer frame ranges, scene attribution, evidence paths and repair owners; the executable defect→patch→rerender→retest loop is implemented and locally verified (2026-11-12) including a real-render segment/full consistency probe. Multimodal creative-acceptance evidence and production acceptance of the repair loop on a narrated defect case remain open.

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

Updated 2026-11-13. **All five mandatory acceptance projects now hold `status: "accepted"` delivery receipts**: startup advertisement (24 s, Fish Audio Sarah voice + synthesized SFX, three aspect-ratio variants), kinetic typography (18 s, Fish narration), narrated explainer (18 s, Fish narration chosen by producer review over the SAPI version), data visualization (19 s, IRENA-sourced charts with provenance), and mixed 2D/3D (Blender 5.3.0 EEVEE scene assembled with HyperFrames scenes). The latest automated suite reports 247 tests, 246 passed, zero failures and one environment-dependent test skipped; suite runs remain local — remote CI is configured (`.github/workflows/ci.yml`) and its first Actions run is pending. `npm audit --omit=dev` reported zero vulnerabilities at the 2026-11-11 update. This is not host runtime verification of Adobe software and not a claim that every milestone is production-accepted.

Runtime evidence: a clean HyperFrames compile/lint/check/snapshot/render and verified FFmpeg delivery passed for the 4-second kinetic typography fixture (`projects/kinetic-type-demo/deliverables/delivery-receipt.json`). The Three.js demo also passes browser render and independent FFprobe checks, and delivery packaging tests exercise local FFmpeg media. These are narrow technical samples, not narrated production acceptance.

The rendered MP4 was also scanned and checksum-verified into the asset registry, attached to a derived Canonical Video IR, converted into an editorial assembly, and exported to FCPXML with its provenance sidecar. The assembly correctly retained an unapproved-rights warning. The interchange has not been imported/read back in Premiere.

| Milestone | Current evidence status | Remaining acceptance evidence |
|---|---|---|
| 0.5–0.9 | Integrated locally; unit/CLI coverage passes | Fresh combined CI on supported platforms; run real asset → derivative → editorial → interchange chain |
| 1.0 | FCPXML exporter, provenance sidecar, multi-track overlap/rational-time golden assertions, and fail-closed safety tests implemented; CLI requires `--allow-unsupported` for intentionally incomplete XML | Live import and readback comparison in licensed Premiere; publish a version compatibility record from that evidence |
| 1.1 | Provider-neutral MCP stages, optional OpenRouter CLI adapter, and immutable planning/IR revision journal with exact-hash approvals implemented | Complete host-harness idea-to-IR render/QA/delivery acceptance; source-grounded web research remains explicit opt-in because search can cost extra; cross-host run orchestration remains open |
| 1.2 | Chart rendering, motion timing, CSS sanitization and typography warnings implemented | Broader layer/template/cache/cancel-resume support and deterministic multi-scene renderer runtime acceptance |
| 1.3 | FFmpeg audio mixing integration verifies a real H.264/AAC master; offline TTS creates project-scoped speech assets, measured narration cues and captions; final audio QA records integrated loudness, loudness range and true peak with structured limit findings; delivery validates caption frame bounds, Unicode and millisecond timing representation; the 18-second narrated sample's render and package are independently verified | Human speech intelligibility and mix review, reviewed caption wording/sync, clipping/distortion review, stem exports, licensed music/SFX, voice rights, and complete narrated production acceptance |
| 1.4 | Governed Adobe MCP client and host readiness/approval gates implemented | Real licensed After Effects, Premiere and Media Encoder operations with checkpoint/readback/export receipts |
| 1.5 | Blender scene contract/adapter implemented; first real runtime render receipt (Blender 5.3.0, 480×270×24-frame EEVEE fixture); **mixed 2D/3D assembly path implemented and runtime-verified (180-frame 3-scene master, 2026-11-13)** | Camera/lighting/asset fixtures, failed-frame recovery, alpha, single-scene multi-engine compositing, explicit start offsets, audio in assembled masters |
| 1.6 | Three.js adapter, CLI/MCP render operation and local runtime fixture implemented; HyperFrames lint/check/snapshot/render and FFprobe verification passed | Broader shader/particle/model/alpha support and mixed-scene editorial acceptance |
| 1.7 | Repair execution loop implemented and locally verified (2026-11-12): defects carry frame ranges + scene ownership, scoped rerender via HyperFrames `--composition` with passing consistency probe, escalation reports, single policy source | Production acceptance of the repair loop on a narrated defect case + multimodal evidence |
| 1.8 | Master/profile transcodes, captions, source and portable IR, referenced-asset packaging, editorial/render/QA/operation/software evidence, available QA frames, human report and SHA-256 integrity verification implemented; local FFmpeg integration cases pass, including traversal/tamper rejection | Narrated production package; engine source project references, production-ready render evidence and reproducible rebuild comparison |
| 1.9 | Installer and host process safety foundation; local runtime now requires a >=32-byte bearer token and uses constant-time comparisons, covered by loopback HTTP integration tests | Secure OS-backed token storage, fresh Windows/macOS/Linux install, upgrade/uninstall, host matrix, recovery and security acceptance |

No milestone is marked production-accepted by this integration. A passing automated test suite does not replace actual renderer/editor execution or the five end-to-end acceptance projects.

**Status discipline:** Update this table only when evidence is attached. CI success is not runtime verification; runtime verification is not production acceptance. The current environment has no Blender or Adobe desktop applications, so their runtime exit gates remain open.

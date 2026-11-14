# Motion Studio — Complete remaining implementation plan

The plan should be driven by the official Architecture Lock and the product’s end-to-end definition of done, not simply by adding more milestone numbers or integrations.

The central acceptance target is:

> A user provides a video idea, and Motion Studio autonomously turns it into a professional, narrated, edited, quality-checked video—with its source project, assets, captions, provenance, and delivery evidence.

The Architecture Lock establishes the intended production flow:

Canonical Video IR → scene routing → scene rendering → specialist After Effects work where needed → Premiere editorial assembly → Media Encoder / FFmpeg delivery → independent output inspection.

It also fixes the primary roles: HyperFrames + GSAP for programmable 2D, After Effects for specialist VFX/compositing, Premiere for editorial assembly, Blender for 3D, Three.js for procedural/WebGL 3D, and FFmpeg/FFprobe for media processing and validation. DaVinci Resolve is outside the locked stack; Remotion is optional, not a primary engine.

This roadmap will preserve those decisions and close the gaps against them.

## 1. Current baseline: what is already built

The repository has a substantial foundation. The plan should retain this work rather than rebuild it.

| Area                            | Current position                     | Remaining work                                                 |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Canonical Video IR              | Implemented                          | Extend contracts only where production requires it             |
| Agent roles and orchestration   | Foundation implemented               | Connect agents into a complete production workflow             |
| Installation and software setup | Foundation implemented               | Fresh-machine and upgrade/uninstall validation                 |
| HyperFrames + GSAP              | Compiler and render path implemented | Broader production capabilities and end-to-end validation      |
| Asset registry                  | Implemented                          | Discovery providers, stronger rights workflows and relinking   |
| Media derivatives               | Implemented                          | Editorial integration and expanded preview tooling             |
| Editorial assembly              | Implemented                          | Validate all required sequence structures                      |
| Premiere interchange            | Initial implementation               | Complete tests, import documentation and live round-trip       |
| Render QA                       | Deterministic checks implemented     | Deeper visual, creative and audio evaluation                   |
| Bounded repair                  | Framework implemented                | Connect actual defect-to-patch-to-rerender execution           |
| Adobe MCP                       | Client and approval foundation       | Real AE/Premiere operations and workstation verification       |
| Blender                         | Foundation/configuration             | Actual render adapter                                          |
| Three.js                        | Foundation/configuration             | Actual render adapter                                          |
| Final delivery                  | Partial                              | Complete finishing, mastering, variants and acceptance package |

Important: PRs #7, #8 and #9 represent the recent asset, derivative, editorial and Premiere work. They should be integrated and validated in dependency order before treating those capabilities as part of a stable release. Their CI success is not equivalent to a real Adobe workstation test.

# 2. Remaining milestones

I recommend dividing the remaining work into ten implementation milestones. Each milestone has a defined deliverable and exit gate.

## Milestone 1.0 — Close and stabilize the existing foundation



First priority

&#x20;Finish existing work before expanding scope



Goal: Make the existing foundation reliable and establish a verified baseline for the next production stages.

### Tasks

1\. Complete Premiere interchange

- Finish explicit sequence and overlap-aware track mapping.
- Add golden FCPXML fixtures.
- Test multiple video, audio and graphics tracks.
- Test source in-points, clip offsets, durations and frame-rate conversion.
- Test unsupported clip types and unresolved media.
- Document import into supported Premiere versions.
- Test importing the generated FCPXML into a real Premiere project.
- Read back the imported sequence and compare it with the editorial manifest.

2\. Stabilize the dependency chain

- Integrate asset intelligence.
- Integrate media derivatives.
- Integrate editorial assembly.
- Integrate Premiere interchange.
- Verify that each downstream package works with the preceding package's actual output.

3\. Strengthen the common production contract

- Ensure all engine outputs declare dimensions, frame rate, duration, color space, alpha support, codec and audio metadata.
- Verify project revision and source hashes are carried between stages.
- Reject incomplete artifacts instead of marking them successful.

Deliverables

- Stable foundation release candidate.
- Complete Premiere interchange test suite.
- Documented import and compatibility procedure.
- End-to-end package integration tests.

Exit gate: A validated IR can produce an editorial manifest, then a valid FCPXML package, and that package can be imported and checked in a licensed Premiere installation.

## Milestone 1.1 — Autonomous creative production pipeline

Core product milestone

Goal: Connect the existing agent roles into a real production pipeline. This is one of the most important remaining gaps.

### Tasks

1\. Production intake

- Accept a natural-language idea or detailed brief.
- Identify target audience, purpose, duration, language, platform and aspect ratio.
- Collect optional brand guidelines, reference videos and supplied assets.
- Identify missing information and request only necessary clarification.
- Generate a structured production brief.

2\. Research department

- Research facts and references when the brief requires them.
- Store source URLs and claim-level evidence.
- Identify unsupported claims.
- Record reference-media provenance and usage restrictions.
- Distinguish factual research from creative inspiration.

3\. Creative direction

- Generate multiple creative concepts.
- Define the selected concept, narrative, tone and visual language.
- Establish the hook, message hierarchy and call to action.
- Define pacing and visual consistency rules.

4\. Scriptwriting

- Generate narration and on-screen copy.
- Assign estimated and final frame ranges to script segments.
- Calculate timing from narration duration.
- Check word count, speaking pace and scene duration.
- Keep spoken narration separate from visible text.

5\. Storyboarding

- Convert the approved script into scenes.
- Specify scene purpose, duration, composition, camera, typography, animation and transitions.
- Identify asset requirements.
- Specify audio cues.
- Define what should be visible at important frames.

6\. Design system generation

- Generate project-specific brand tokens.
- Define colors, typography, spacing, safe areas and motion presets.
- Check font availability and glyph coverage.
- Create reusable design components.

7\. IR generation

- Convert the production brief, script, storyboard and design system into Canonical Video IR.
- Validate all references and timing.
- Keep creative intent independent of rendering-engine implementation.
- Version every approved production revision.

Deliverables

- Connected creative-agent workflow.
- Production brief schema.
- Script and storyboard contracts.
- Design-system generator.
- Validated IR generated from a natural-language idea.

Exit gate: A user can provide an idea and receive an approved, complete, render-ready Canonical Video IR without manually constructing the project JSON.

## Milestone 1.2 — Production-grade HyperFrames + GSAP renderer

Goal: Make HyperFrames the dependable primary engine for 2D motion graphics, typography and graphical scenes.

### Tasks

1\. Expand layer support

- Text and rich typography.
- Shapes and vector-style graphics.
- Images and video.
- Audio.
- Charts and data visualization.
- Composite and grouped layers.
- Masks and supported effects.
- Backgrounds, gradients and overlays.

2\. Motion system

- Reusable animation presets.
- Keyframe interpolation.
- Easing and motion curves.
- Entrance, exit and emphasis animations.
- Scene transitions.
- Staggered animation.
- Camera-like movement for 2D compositions.
- Deterministic animation seeking at arbitrary frames.

3\. Typography

- Responsive font sizing.
- Text wrapping and line-height control.
- Automatic fit-to-container.
- Safe-area validation.
- Font fallback detection.
- Text animation presets.
- Subtitle and lower-third components.

4\. Composition system

- Reusable scene templates.
- Nested compositions where supported.
- Brand component library.
- Shared style tokens.
- Consistent scene transitions.
- Deterministic IDs and stable compilation.

5\. Render performance

- Scene-level caching.
- Incremental rendering.
- Memory-aware scheduling.
- Render cancellation and resume.
- Render progress reporting.
- Consistent draft and final profiles.

Deliverables

- Expanded HyperFrames compiler.
- Motion preset library.
- Reusable graphics and typography components.
- Scene rendering cache.
- Renderer capability documentation.

Exit gate: A multi-scene professional 2D motion-graphics project can be rendered deterministically from IR, with no unsupported layer silently disappearing or becoming an unapproved placeholder.

## Milestone 1.3 — Complete FFmpeg post-production and mastering

Goal: Turn individual scene renders into a finished, synchronized video.

This must be a real execution pipeline, not just FFmpeg command planning.

### Tasks

1\. Scene assembly

- Combine scene renders in the correct frame order.
- Handle transitions and overlaps.
- Preserve exact frame timing.
- Support different scene source formats.
- Validate frame-rate consistency.

2\. Audio production

- Combine narration, music and SFX.
- Align audio to scene and script timing.
- Apply gain, fades and ducking.
- Mix multiple audio tracks.
- Detect clipping and unwanted silence.
- Support audio stems.

3\. Captions and subtitles

- Generate subtitles from approved narration.
- Support SRT and WebVTT.
- Generate styled subtitle overlays.
- Synchronize subtitle timing to the final video.
- Support language-specific text and font handling.

4\. Visual finishing

- Add overlays, logos and end cards.
- Apply supported color and finishing operations.
- Normalize output dimensions and frame rate.
- Handle letterboxing or cropping according to the delivery profile.

5\. Export profiles

- 16:9.
- 9:16.
- 1:1.
- Custom aspect ratios.
- Platform-specific codec, bitrate, audio and resolution presets.

6\. Output verification

- Probe final files using FFprobe.
- Check codec, duration, dimensions and frame rate.
- Check audio stream presence and synchronization.
- Check output integrity.
- Generate final inspection frames.

Deliverables

- Executable FFmpeg assembly pipeline.
- Audio mixing and synchronization system.
- Caption generation and rendering.
- Export profiles.
- Final media verification report.

Exit gate: A collection of rendered scenes, narration, music and captions becomes a single verified final MP4 with synchronized audio and the requested export profile.

## Milestone 1.4 — Complete After Effects and Premiere production integration

Goal: Move from Adobe connection scaffolding and interchange files to governed, verifiable editor operations.

### A. After Effects integration

- Verify live AE connection and host capabilities.
- Create a copied project or checkpoint before edits.
- Create editable compositions from approved scene specifications.
- Set composition dimensions and frame rates.
- Create and modify layers.
- Import approved assets.
- Apply supported effects and animation.
- Create specialist VFX/compositing work.
- Save the project.
- Render the required comp.
- Read back composition and render state.
- Return artifact paths and operation evidence.

The upstream `mcp-aftereffects` integration remains the editor-control layer. Motion Studio should own the orchestration, validation, approvals and project-level contracts.

### B. Premiere integration

- Import verified scene renders and AE outputs.
- Create or import sequences.
- Create and organize tracks.
- Position clips accurately.
- Apply supported transitions.
- Add narration, music and SFX.
- Add and synchronize captions.
- Verify sequence structure after edits.
- Save checkpoints.
- Export through the appropriate Adobe workflow.
- Read back export status and inspect the resulting media.

### C. Adobe governance

- Read-only operation by default.
- Exact-operation approval for writes.
- Project and sequence scope restrictions.
- Pre-edit checkpoints.
- Post-edit readback.
- No blind retry after uncertain operations.
- No arbitrary script execution by default.

### D. Media Encoder

- Integrate the Adobe export queue where supported.
- Manage export presets.
- Track queue and job status.
- Verify completed output independently.
- Fall back only through an explicit, approved workflow.

Deliverables

- AE composition workflow.
- Premiere assembly workflow.
- Media Encoder handoff.
- Adobe operation receipts.
- Version and capability compatibility matrix.

Exit gate: A licensed workstation completes a real AE composition operation, a real Premiere sequence assembly and a final export. Motion Studio reads back and verifies each result.

## Milestone 1.5 — Real Blender 3D rendering engine

Goal: Implement Blender as a working scene renderer rather than merely detecting its installation.

### Tasks

- Define IR-to-Blender scene mapping.
- Generate Blender scene files.
- Create objects, meshes and materials.
- Support camera and lighting configuration.
- Import supported 3D assets.
- Support animation and keyframes.
- Support basic particle and simulation workflows.
- Configure render engines and quality settings.
- Render image sequences with alpha where required.
- Generate scene metadata and render receipts.
- Support cancellation and resumable frame rendering.
- Convert rendered sequences into the common engine output contract.
- Integrate Blender artifacts into Premiere assembly.

Deliverables

- `@motion-studio/blender-adapter`.
- Scene compiler.
- Render manager integration.
- Asset and material mapping.
- Blender test projects and render fixtures.

Exit gate: A 3D scene specified through IR renders successfully in Blender and is incorporated into a mixed 2D/3D video.

## Milestone 1.6 — Real Three.js procedural 3D engine

Goal: Implement Three.js as a separate, useful rendering adapter.

### Tasks

- Define IR-to-Three.js mapping.
- Create scene, camera and lighting systems.
- Support geometry and material generation.
- Support shader-based effects.
- Support animation timelines.
- Support procedural graphics.
- Support particle systems.
- Integrate GSAP where useful.
- Render deterministic frames using the approved browser workflow.
- Capture image sequences.
- Validate alpha, dimensions, timing and output metadata.
- Integrate rendered frames with the common pipeline.

Deliverables

- `@motion-studio/threejs-adapter`.
- Scene compiler.
- Shader and procedural preset library.
- Browser render integration.
- Render verification tests.

Exit gate: A procedural 3D scene can be generated from IR, rendered frame-accurately and incorporated into a final video.

## Milestone 1.7 — Full visual, audio and creative QA with autonomous repair

Goal: Turn the existing deterministic QA framework into a comprehensive quality-control system.

The current QA foundation already has meaningful technical checks. The remaining work is to connect deeper analysis to actionable, verifiable repairs.

### A. Technical QA

- Schema and semantic validation.
- Frame-accurate timing checks.
- Missing media and font checks.
- Render output validation.
- Resolution and frame-rate checks.
- Codec and color-space validation.
- Black-frame and freeze detection.
- Audio silence and clipping detection.
- File integrity checks.

### B. Visual QA

- Text overflow and clipping.
- Typography consistency.
- Contrast and readability.
- Safe-area violations.
- Composition balance.
- Alignment and spacing.
- Scene continuity.
- Transition quality.
- Flicker and unwanted flashes.
- Duplicate or frozen visual content.
- Missing or incorrect visual assets.

### C. Audio QA

- Narration synchronization.
- Music and SFX synchronization.
- Loudness consistency.
- Clipping and distortion.
- Unwanted silence.
- Speech intelligibility.
- Music/narration balance.

### D. Creative QA

- Does the video deliver its intended message?
- Is the opening hook effective?
- Does the story progress logically?
- Is the pacing appropriate?
- Does the video remain consistent with the art direction?
- Is the call to action clear?
- Does the result match the original brief?

### E. Repair execution

The repair system should:

1. Identify the defect.
2. Record evidence and exact frame/time ranges.
3. Identify the responsible scene, layer or production stage.
4. Determine whether the issue is technical, visual, audio or creative.
5. Generate the smallest valid repair.
6. Validate the changed IR or engine project.
7. Rerender only affected components where possible.
8. Re-run the relevant QA checks.
9. Escalate unresolved critical issues.

Keep automatic repair bounded. The existing architecture's default limit is two automatic cycles; the 0.5 implementation allows a configurable maximum of three attempts. These policies should be reconciled into one documented production policy rather than silently changing retry behavior.

Deliverables

- Visual critic provider integration.
- Audio QA subsystem.
- Creative critic.
- Evidence-linked defect model.
- Scene-level repair execution.
- Regression and retest framework.

Exit gate: Injected defects in a test video are detected, localized, repaired where permitted, rerendered and shown to pass the relevant retests—or explicitly escalated.

## Milestone 1.8 — Complete delivery and production packaging

Goal: Make every successful production a complete, traceable delivery rather than just an MP4 file.

### Tasks

- Generate final master video.
- Generate requested platform variants.
- Generate captions and subtitle files.
- Package source project and Canonical Video IR.
- Include required assets and derivatives.
- Include AE, Premiere and Blender project references where applicable.
- Include source hashes and provenance.
- Include asset rights-review records.
- Include render manifests.
- Include QA report and defect history.
- Include export and verification receipts.
- Include software and engine versions.
- Include production settings and delivery profile.
- Generate a human-readable delivery summary.

### Delivery structure

```
delivery/
  final/
    master.mp4
    social-vertical.mp4
    square.mp4
  captions/
    subtitles.srt
    subtitles.vtt
  project/
    canonical-video-ir.json
    editorial-assembly.json
    premiere-handoff.fcpxml
    ae-projects/
    blender-projects/
  assets/
    source-manifest.json
    derivatives/
  evidence/
    render-manifest.json
    qa-report.json
    qa-frames/
    export-verification.json
  provenance/
    source-hashes.json
    software-versions.json
    operation-history.json
  DELIVERY-REPORT.md
```

The exact folders should depend on the production and the assets actually used. Do not package unavailable or unnecessary editor projects as if they were created.

Deliverables

- Delivery manager.
- Packaging and integrity verification.
- Multiple output profiles.
- Human-readable delivery report.
- Reproducibility metadata.

Exit gate: A completed project produces a verified, self-describing delivery package with all required source and evidence artifacts.

## Milestone 1.9 — Learning, portability, security and release hardening

Goal: Make the platform dependable across machines and supported AI hosts.

### A. Learning system

- Store project-specific memory separately from user style preferences.
- Store validated reusable production patterns separately from both.
- Capture approved creative decisions and repair outcomes.
- Propose reusable skill and template improvements.
- Evaluate proposals against test projects.
- Version and approve skill changes.
- Maintain rollback metadata.
- Never silently promote code, dependencies, permissions or secrets.

### B. Host portability

- Z Code adapter.
- Claude Code adapter.
- Codex adapter.
- Cursor adapter.
- Generic MCP integration.
- Host-version compatibility checks.
- Configuration-preserving installation and removal.
- Host-specific capability testing.

The official architecture explicitly requires separate adapters. Do not assume one MCP manifest or plugin lifecycle works for every host.

### C. Installer and software doctor

- Fresh Windows installation.
- Fresh macOS installation.
- Fresh Linux open-source installation.
- Dependency version checks.
- Disk and memory checks.
- FFmpeg and browser checks.
- Blender detection and verification.
- Adobe application detection.
- Adobe connector verification.
- MCP server health checks.
- Repairable installation diagnostics.
- Safe upgrade and uninstall.
- Machine-readable installation report.

Adobe products remain user-installed and user-licensed. The installer can prepare integrations and guide the installation, but cannot bypass sign-in, subscription, entitlement or activation.

### D. Security and reliability

- Local-first execution.
- Loopback-only protected runtime.
- Authenticated API operations.
- Secure token storage.
- Allowlisted process execution.
- Workspace path restrictions.
- Untrusted media and prompt-injection protections.
- Project checkpoints.
- Approval and operation audit records.
- Resource-aware render scheduling.
- Safe cancellation and recovery.
- No arbitrary Adobe scripts by default.

### E. Release engineering

- Windows, macOS and Linux CI.
- Supported Node version matrix.
- Unit and integration tests.
- Real-media fixture tests.
- Installer upgrade/uninstall tests.
- Live Adobe workstation test receipts.
- Engine compatibility matrix.
- Release notes and migration documentation.

Exit gate: A clean installation can configure the open-source pipeline, connect supported editor integrations after user setup, execute verified productions and uninstall without damaging user software or project data.

# 3. Milestone dependency map

The order matters. Some work can be developed in parallel, but the final production path has hard dependencies.

## Implementation sequence

1. 1.0 — Foundation closure

   Existing asset → derivative → editorial → Premiere work
2. 1.1 — Creative production pipeline

   Idea → research → brief → script → storyboard → IR
3. 1.2 — HyperFrames production renderer

   Render complete 2D scenes from generated IR
4. 1.3 — FFmpeg finishing

   Assemble scenes, audio, captions and output profiles
5. 1.7 — QA and repair integration

   Run throughout development; complete acceptance gate here
6. 1.4 — Adobe production workflow

   After Effects → Premiere → Media Encoder
7. 1.5 — Blender adapter

   3D scene production
8. 1.6 — Three.js adapter

   Procedural/WebGL production
9. 1.8 — Complete delivery

   Source projects, masters, variants and evidence
10. 1.9 — Production release

    Learning, portability, security and release verification

Important sequencing decision: We should not wait for Blender and Three.js before proving the complete 2D production pipeline. The first end-to-end acceptance video should be completed with HyperFrames, FFmpeg and the existing QA foundation. Adobe and 3D support then extend a working production system instead of becoming prerequisites for proving that the system works.

# 4. Five mandatory end-to-end acceptance projects

A milestone should not be considered complete just because its individual package tests pass. These five productions will prove that the whole platform works.

[What is Video Production? The 2026 Guide to Product Videos - Leadde Blog](https://images.openai.com/static-rsc-4/jm19L9dGHAdUXEtzShh0kkqJCmGUolgpTWAAAA-fR517LMBMZu8JJp6LU9tvNcO1rI5Nf71_IQjnC2R9TWp7kV1nRg_7l9MwK7yyVuoJnlYvr9MND5nWlzH0FANUkcDdUjtbN7Iwu864kd2O53bP1sdOUNtUBt2TH5pfJpfKBHs?purpose=inline)

Test 1 — Startup advertisement

15–30 seconds, branded motion graphics, product visuals, animated text, music and CTA.

Proves creative pipeline, typography, HyperFrames, audio and delivery.

Test 2 — Kinetic typography

Narration-driven text animation, transitions, precise timing and typography-safe-area checks.

Proves frame timing, GSAP, text fitting and captions.

[Ed Tech Explainer video |Motion graphics Animated Video :: Behance](https://images.openai.com/static-rsc-4/8KGc9ujb7dfOX8wyadnnYVvIarbdcTboMh4kHl0spH2vyyH4G4Es64lMogkAzhgXeIbfJBqlC9gAm1_vd_DwbgkF_ajaYl80__oprQ7RF6GAH7RNxjg3Kz_em3C27bixczZCDSAf9287rllwihEhzsdarh4sSQodPSAURi6dG2o?purpose=inline)

Test 3 — Narrated explainer

Research-backed script, narration, graphical scenes, subtitles, music and final mix.

Proves research, script, storyboard, audio, captions and QA.

[Transforming Banking: The Growing Role of AI in Financial Services | ATM Marketplace](https://images.openai.com/static-rsc-4/8jIKfinrTfMnprdrsXfHSSMKiapQrLxkjcc2hfGIU8nPeagEOPSLiKopEojTeMsb0QDYPPviHPOlVV9Vy9SytngtLHng44M5UTqhLga-PsGA_b5z6PhGPCz-l15XQubDuKODyobxja2uaMDhFP8iSg5uUkVaXgO0o_4hZWVQHB8?purpose=inline)

Test 4 — Data visualization video

Animated charts, statistics, source evidence, transitions and consistent visual hierarchy.

Proves structured data, graphics, factual evidence and visual QA.

[Ecommerce Product Promo Video Generator for Converting Ads | CinemaDrop](https://images.openai.com/static-rsc-4/06IEkiHujLy12wZiykISJK4Eplf_HhiuC_-VUTr7uVMbIxHAzOtURHmNOCRNvSjJw61m-hvNrmj9sRdwkzQIqHKy7Q2c506AqEQc-MY7PoydZt4_JQPVi0lksLgQD3RRTP4CiUlGTWRCeQoA0ZaGr6_kXoH_ghdppyovVO8ISe8?purpose=inline)

Test 5 — Mixed 2D and 3D production

HyperFrames graphics, Blender or Three.js 3D, AE compositing and Premiere editorial assembly.

Proves multi-engine routing, Adobe integration and mixed-scene delivery.

Every acceptance project must produce:

- Final MP4.
- Canonical Video IR.
- Script and storyboard.
- Required source project files.
- Asset and provenance manifests.
- Captions when applicable.
- Render and export receipts.
- QA report and sampled-frame evidence.
- Reproducible project configuration.

# 5. Global definition of done

The whole project is complete only when all these conditions are met.

| Acceptance area         | Required evidence                                                   |
| ----------------------- | ------------------------------------------------------------------- |
| Natural-language intake | Idea converted into a valid production brief                        |
| Creative planning       | Script, storyboard and design system generated                      |
| Canonical IR            | Validated, versioned production specification                       |
| Asset management        | Hashed, traceable and rights-reviewed inputs                        |
| Engine routing          | Correct engine chosen using actual capabilities                     |
| HyperFrames             | Real, verified 2D render                                            |
| After Effects           | Real, verified specialist composition                               |
| Premiere                | Real, verified sequence assembly                                    |
| Blender                 | Real, verified 3D scene render                                      |
| Three.js                | Real, verified procedural scene render                              |
| Audio                   | Narration, music and SFX synchronized and mixed                     |
| Captions                | Correctly timed subtitle artifacts                                  |
| QA                      | Technical, visual, audio and creative evidence                      |
| Repair                  | Bounded repair and successful retesting                             |
| Delivery                | Verified final master and requested variants                        |
| Provenance              | Source, tool, asset and operation records                           |
| Installation            | Tested fresh-machine setup                                          |
| Security                | Approval gates, safe process execution and protected local services |
| Portability             | Supported host adapters tested independently                        |

No single CI result can satisfy all of these. We need separate evidence for automated tests, real renderer execution, real Adobe workstation operations and complete production acceptance.

# 6. What we should deliberately not build

To keep the roadmap focused on the official architecture, these should not become accidental scope expansions:

- Do not replace HyperFrames with Remotion as the primary renderer.
- Do not add DaVinci Resolve as a primary target engine.
- Do not create separate creative-production cores for each AI host.
- Do not silently install or activate licensed Adobe products.
- Do not edit `.aep` or `.prproj` files as opaque binaries.
- Do not allow agents to silently change executable code, permissions or dependencies.
- Do not mark a production delivered because a render command returned success.
- Do not treat an asset checksum or producer rights-review record as legal clearance.
- Do not implement cloud rendering or autonomous publishing by default; both require separate architecture decisions.

These boundaries come from the Architecture Lock and orchestration security design.

# 7. Recommended execution priorities

My recommendation is to use this order of engineering priority:

| Priority | Work                                       | Reason                                            |
| -------- | ------------------------------------------ | ------------------------------------------------- |
| P0       | Complete and stabilize 1.0                 | Secure the existing foundation                    |
| P0       | Complete creative pipeline                 | Connect the idea to the production system         |
| P0       | Finish HyperFrames + FFmpeg vertical slice | Prove actual end-to-end video creation            |
| P0       | Integrate QA and repair                    | Prevent low-quality output from reaching delivery |
| P1       | Live After Effects and Premiere workflow   | Complete the locked Adobe production path         |
| P1       | Full delivery package                      | Make output usable and reproducible               |
| P2       | Blender adapter                            | Add real 3D production                            |
| P2       | Three.js adapter                           | Add procedural/WebGL production                   |
| P2       | Learning and portability hardening         | Improve repeatability and release quality         |

The key engineering principle is that we should complete working production capabilities, not merely add integration packages.

## 8. Project tracking and implementation rules

For every milestone, we should require:

1. A dedicated Git branch and pull request.
2. A written scope and implementation checklist.
3. Tests for every new package and CLI/MCP operation.
4. Regression tests for existing functionality.
5. Cross-platform CI where applicable.
6. Real execution evidence for render and editor capabilities.
7. Updated architecture and operator documentation.
8. A clear list of completed, deferred and blocked work.
9. No merging or declaring completion solely because code has been written.

A useful distinction for the project tracker is:

- Implemented: code exists.
- CI verified: automated tests pass.
- Runtime verified: actual software or renderer executed successfully.
- Production accepted: a complete acceptance project passed its delivery gates.

That prevents us from confusing a functioning scaffold with a finished feature.

## Final recommendation

I would make Milestone 1.1 — Autonomous creative production pipeline the next major development milestone after closing the existing 1.0 work. In parallel, we can prepare the HyperFrames production gaps, but we should not start Blender or Three.js implementation ahead of the first complete 2D production.

The next durable project artifact should be a repository document named `docs/MASTER-REMAINING-IMPLEMENTATION-ROADMAP.md`, containing this roadmap, milestone checklists, dependencies, acceptance gates and status tracking. It should become the master reference for all subsequent milestone PRs.
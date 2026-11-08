# Motion Studio — Master Remaining Implementation Roadmap

This is the working roadmap for the repository. It follows the Architecture Lock and the product definition of done: a user provides an idea, and Motion Studio produces a narrated, edited, quality-checked video with its source project, assets, captions, provenance, and delivery evidence.

## Architecture and completion rules

The production path is Canonical Video IR → scene routing → scene rendering → specialist After Effects work where needed → Premiere editorial assembly → Media Encoder or FFmpeg delivery → independent output inspection. HyperFrames + GSAP is the primary programmable 2D renderer; Blender and Three.js serve 3D work; FFmpeg/FFprobe provide media processing and verification. Adobe products remain user-installed and licensed.

Track each capability as **implemented**, **CI verified**, **runtime verified**, or **production accepted**. Code or unit tests alone do not satisfy runtime or production gates. Do not edit Adobe project binaries, run arbitrary host scripts by default, silently promote code or permissions, or accept delivery based on command success alone.

## Milestones and current status

| Milestone | Scope | Status in this checkout | Exit gate |
|---|---|---|---|
| 1.0 Foundation | Stable IR, timing, hashes, dependency chain, editorial/interchange fixtures | Partial | IR → editorial manifest → FCPXML; golden multi-track fixtures; import/readback receipt from licensed Premiere |
| 1.1 Creative pipeline | Intake, research/evidence, creative direction, script, storyboard, design system, validated IR | Foundation only | Idea produces a complete approved render-ready IR without hand-authoring project JSON |
| 1.2 HyperFrames + GSAP | Rich layers, motion presets, typography/components, cache/resume/progress | Partial | Deterministic multi-scene 2D render; no unsupported layer silently omitted or replaced |
| 1.3 FFmpeg finishing | Scene assembly, audio stems/mix, captions, mastering, profiles and inspection | Partial | Scene renders + synchronized narration/music/captions become verified requested master |
| 1.4 Adobe workflow | Governed AE compositions, Premiere sequences, Media Encoder and readback | Foundation only | Approved host operations, checkpoints and independent output verification on licensed workstation |
| 1.5 Blender | Explicit 3D scene adapter and runtime render | Adapter implemented; host gate open | Actual Blender render receipt and mixed 2D/3D delivery |
| 1.6 Three.js | Procedural/WebGL scene adapter and deterministic frame renderer | Not implemented | Browser-rendered scene frames and verified delivery |
| 1.7 QA and repair | Technical, visual, audio and creative QA; bounded patch/rerender | Partial | Defect → bounded repair → rerender → passing evidence |
| 1.8 Delivery | Profiles, assets, source, provenance, captions, evidence and report | Partial | Self-describing package with all required artifacts, hashes and accepted receipt |
| 1.9 Learning, portability and release | Governed learning, host adapters, installer, security and release CI | Partial | Fresh install, upgrade/uninstall, host capability checks and release gates across supported systems |

## Dependency order

1. Close and stabilize 1.0.
2. Connect the creative pipeline in 1.1.
3. Complete the HyperFrames renderer (1.2) and FFmpeg vertical slice (1.3).
4. Integrate QA and bounded repair (1.7) throughout the path.
5. Complete the Adobe workflow (1.4), then Blender (1.5) and Three.js (1.6).
6. Complete reproducible delivery (1.8) and portability/release gates (1.9).

The first complete production should use the working 2D path; 3D and Adobe work extend it and must not be treated as prerequisites for proving that path.

## Acceptance productions

Maintain five end-to-end acceptance projects: a 15–30 second startup advertisement; narration-driven kinetic typography; a research-backed narrated explainer; a data-visualization video with claim evidence; and a mixed 2D/3D production with Adobe editorial work. Each accepted project includes its final master, Canonical Video IR, script/storyboard, source project, asset/provenance manifests, captions where applicable, render/export receipts, QA report and sampled-frame evidence, and reproducible configuration.

## Global definition of done

- Natural-language intake yields a structured brief, creative plan, script, storyboard, design system and validated versioned IR.
- Assets have hashes, provenance and reviewed rights status; routing follows declared engine capabilities.
- HyperFrames, After Effects, Premiere, Blender and Three.js have actual runtime evidence for their assigned work.
- Narration, music and effects are synchronized and mixed; captions are timed and checked.
- Technical, visual, audio and creative QA evidence exists; bounded repairs are retested.
- Delivery contains verified masters and requested variants, source, assets, provenance and operation evidence.
- Fresh installation, security controls, independent host adapters and supported platform release checks pass.

CI results, real renderer execution, Adobe workstation receipts and complete production acceptance are separate evidence classes. No one class substitutes for another.

## Deliberate boundaries

Do not replace HyperFrames with Remotion as the primary engine; add DaVinci Resolve as a primary target; create separate creative cores per AI host; silently install or activate licensed Adobe products; treat checksums or producer review as legal clearance; or add cloud rendering/autonomous publishing without a separate architecture decision.

## Current evidence and next gates

Current local evidence and known gaps are maintained in [IMPLEMENTATION-STATUS-1.0.md](IMPLEMENTATION-STATUS-1.0.md) and [BUILD-REPORT.md](../BUILD-REPORT.md). In this checkout the kinetic-typography fixture has an accepted silent package; it does not meet narrated-video completion. Open gates include provider-backed creative production, FCPXML/Premiere round-trip, live AE/Premiere operations, actual Blender runtime, Three.js adapter, broader FFmpeg assembly and audio/caption production, visual/creative QA and repair, and cross-platform installer/host evidence.

For each milestone, maintain a dedicated branch/PR, scope checklist, package and CLI/MCP tests, regression coverage, cross-platform CI where applicable, real execution evidence, updated operator docs, and explicit completed/deferred/blocked items. Do not declare completion solely because code has been written.

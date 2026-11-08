# Motion Studio 0.3.0-alpha.1 — Build report

## Current implementation

- Canonical Video IR validation, integer-frame timing, engine routing and structured deterministic QA.
- HyperFrames + GSAP compilation from IR, with scene source files, deterministic composition entrypoint, lint/runtime/layout checks, snapshots, low-memory render mode and output probing.
- Local render evidence with FFprobe inspection and extracted QA frames; render status distinguishes technically verified output from production readiness when assets or engines are missing.
- FFmpeg execution behind a fixed `ffmpeg` / `ffprobe` allowlist and argument arrays: dimension/frame-rate normalization, audio offsets/gain/mixing, subtitle burn-in, output probing and contract checks.
- Delivery packaging for MP4, MOV, WebM and ProRes profiles, thumbnails, SRT/VTT sidecars, source project, asset manifest, provenance and a delivery receipt. A package is not marked accepted without verified production-ready render evidence and cleared asset rights.
- Render receipts hash the canonical IR; delivery requires the packaged IR hash to match the one actually rendered.
- Bounded production run state machine, execution graph validation and governed proposal/evaluation/approval workflow.
- Read-only-by-default After Effects and Premiere MCP launch policy. The Adobe applications remain external, separately licensed workstation dependencies.
- Pinned npm dependencies and lockfile. The current dependency audit reports zero known vulnerabilities.

## Verification status

- Local automated suite: 36 tests pass (Node 24, Windows).
- CI defines Node 24/26 across Windows, macOS and Ubuntu; remote matrix results are not inferred from local runs.
- A full 60-second HyperFrames draft render completed on this Windows host. The sample routes a 3D layer to Blender, which is not installed here, so the output passed technical media checks but is explicitly not production-ready.
- A self-contained 4-second kinetic-typography project rendered and passed HyperFrames checks, FFprobe inspection and scene frame decoding; FFmpeg produced a verified profile master and thumbnail, and the delivery receipt is `accepted` for that explicitly silent sample.
- The FFmpeg audio-mix path was exercised with a generated tone fixture; its 4-second output passed independent probing with the required AAC audio stream.
- An IR-to-Blender adapter compiles explicitly declared primitives, materials and integer-frame transforms to a background EEVEE PNG sequence; it checks frame count and probes image dimensions. Blender is absent here, so no real Blender render is claimed.
- FFmpeg / FFprobe are installed locally. After Effects and Premiere live round-trip gates require a licensed Adobe workstation; Blender render gates require Blender. Neither is claimed complete without a host receipt.

## Remaining release gates

- The current checkout does not yet contain asset-intelligence, editorial/interchange, Premiere readback or Three.js adapter packages described in the 1.0–1.9 roadmap. Blender has a first explicit-primitive adapter but no host render receipt.
- Natural-language creative generation, source research, speech generation, music/SFX generation and visual/creative AI critique need configured providers and reviewed production workflows.
- Adobe live readback, true Blender/Three.js rendering, cross-OS test results, installer upgrade/uninstall tests and release publication remain unverified.
- This alpha is not the full end-to-end product definition of done. Do not advertise it as an autonomous narrated-video production release.

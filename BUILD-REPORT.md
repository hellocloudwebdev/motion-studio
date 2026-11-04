# Motion Studio — Build Report

## Main branch: 0.3.0-alpha.1

The 0.3 milestone was merged to `main` in PR #1:
https://github.com/hellocloudwebdev/motion-studio/pull/1

Included:
- Cross-platform bootstrap and managed per-user application installation.
- Skill staging for Claude Code, Codex and Cursor, generic MCP config for Z Code/DeepSeek.
- Canonical Video IR validator and JSON Schema.
- Scene-level engine routing, deterministic QA and production-run state machine.
- HyperFrames/GSAP compiler and render manager with FFprobe output checks and frame evidence.
- Local Adobe MCP clients and scoped launchers for upstream AE/Premiere servers.
- FFmpeg command planning, local runtime and governed learning proposal lifecycle.

The 0.3 head passed six CI jobs across Windows, macOS and Ubuntu with Node.js 24 and 26.

## Active branch: 0.4.0-alpha.1

Branch: `milestone/0.4-adobe-production-orchestration`

Included in the active branch:
- 0.4 Adobe orchestration specification and upstream capability matrix.
- AE scene plan compiler for text and rectangular solid layers, with optional fade/fade-up keyframes.
- Dynamic `ae_catalog` operation discovery and parameter validation.
- One-time approval IDs with expiration/single-use, project-state checks and non-overwriting project backups.
- AE save/composition/layer readback and PNG frame evidence.
- Premiere CEP workflow to import verified scene renders, create a new sequence from clips, verify active sequence identity/structure, save and optionally export/verify.
- Motion Studio MCP preview/apply tools for the Adobe workflows.
- Mocked end-to-end workflow tests; live host proof is not claimed.

## Verification boundary

CI can validate schema conversion, operation arguments, token lifecycle, backup path safety and mocked tool workflows. It cannot prove a licensed After Effects or Premiere application executed the requested operations. 0.4 release acceptance still requires:
- A real AE `.aep` copy with a created composition, readback and frame-proof PNG.
- A real Premiere `.prproj` copy with imported scene clips, a new sequence, verified readback, save and an exported media file.
- A fresh Windows installation with Adobe MCP connections and CEP connector validated.

## Deferred

Blender/Three.js render adapters, expanded editorial timeline tools, comprehensive visual/audio QA, automatic defect repair, persistent production memory, and final production distribution/architecture lock remain later milestones.

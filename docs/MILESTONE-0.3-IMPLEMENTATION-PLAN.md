# Motion Studio 0.3 — Implementation Plan

The architecture and complete end-to-end orchestration are defined in [ORCHESTRATION-DESIGN-0.3.md](./ORCHESTRATION-DESIGN-0.3.md). This page orders the implementation.

## Phase A — Installation and local toolchain
- [ ] Move managed runtime to Node.js 24+ on Windows/macOS/Linux.
- [ ] Add an exact software/package lock and provenance.
- [ ] Implement package-manager detection and non-destructive install.
- [ ] Install HyperFrames CLI and ensure its browser.
- [ ] Install pinned After Effects and Premiere MCP packages locally.
- [ ] Detect Adobe apps and guide users through official Creative Cloud install.
- [ ] Install Premiere CEP connector; provide UXP CCX install and live verification path for supported hosts.
- [ ] Register host MCP entries through safe config merges.
- [ ] Implement software doctor, uninstall and upgrade tests.

## Phase B — Canonical Video IR to HyperFrames
- [ ] Add typed scene/layer contracts for text, shapes, images, video and audio.
- [ ] Convert integer frame timings to exact HyperFrames seconds.
- [ ] Emit deterministic HTML, CSS, assets and GSAP timelines.
- [ ] Extend GSAP duration to scene end.
- [ ] Run CLI lint/check/snapshot/render.
- [ ] Enforce one worker by default.
- [ ] Probe MP4 and capture QA frames.

## Phase C — Adobe MCP orchestration
- [ ] Add MCP child-process manager for pinned Adobe servers.
- [ ] Perform read-only AE context and Premiere connection checks.
- [ ] Add approved/copy-only AE scene-composition workflow.
- [ ] Add Premiere sequence assembly plan and guarded apply/readback.
- [ ] Record app versions, bridge versions, capabilities and output evidence.
- [ ] Never retry uncertain non-idempotent Adobe operations without reconciliation.

## Phase D — QA, repair and delivery
- [ ] Deterministic media/IR checks.
- [ ] Frame sampling and image inspection pipeline.
- [ ] Typography safe-area and font-presence checks.
- [ ] Structured defects and targeted scene rebuild.
- [ ] Bounded repair policy.
- [ ] FFmpeg finalization and delivery receipt.

## Phase E — Architecture lock and release
- [ ] Run tests on Windows, macOS and Ubuntu.
- [ ] Run a real HyperFrames render on a controlled runner.
- [ ] Run live AE/Premiere tests on licensed hosts with test projects.
- [ ] Verify installer upgrade/uninstall and host-config preservation.
- [ ] Publish final architecture lock, compatibility matrix, trust boundary and build report.
- [ ] Create release only after acceptance gates pass.

## Exit rule

No phase is complete from static code or a green unit test alone. Rendering requires a verified media artifact. Adobe control requires a live licensed-host receipt. The final architecture lock must describe exactly what shipped and what remains deferred.

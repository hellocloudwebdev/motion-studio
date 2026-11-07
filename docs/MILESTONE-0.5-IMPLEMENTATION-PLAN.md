# Motion Studio 0.5 — Evidence-driven visual QA and bounded repair

## Objective
Turn rendered output evidence into an explicit, fail-closed quality gate and a deterministic, scene-scoped repair plan. A successful renderer exit code alone must never imply production readiness.

## Included in this increment
- [x] Render evidence evaluator for verified status, artifact presence/size, output-contract checks, decoded frame samples and blocking compiler warnings.
- [x] Structured defects with severity, ownership and mandatory retest semantics.
- [x] Deterministic repair-plan grouping by scene/project scope.
- [x] Hard retry ceiling (maximum three attempts) with explicit human escalation.
- [x] Unit tests for clean evidence, failed checks, failed frame samples, missing evidence and retry exhaustion.

## Remaining 0.5 work
- [ ] Connect the evaluator to the render-manager receipt and CLI quality gate.
- [ ] Add FFmpeg black/frozen-frame and audio-silence analysis with configurable thresholds.
- [ ] Add OCR-based safe-area, text-clipping and subtitle inspection.
- [ ] Add perceptual frame comparison and duplicate-frame detection.
- [ ] Persist repair attempts and QA approvals in the Canonical Video IR without mutating source intent.
- [ ] Add integration fixtures with real MP4 artifacts on Linux, Windows and macOS.
- [ ] Add an opt-in visual-critic provider adapter; provider output must be advisory and never bypass deterministic gates.

## Acceptance criteria
1. Missing or malformed evidence always fails closed.
2. Every failed gate yields a stable defect code, owner and retest requirement.
3. Repair plans are deterministic, scoped and bounded to at most three attempts.
4. Exhausted repairs escalate; no autonomous infinite loop.
5. Production readiness is true only when evidence passes and the renderer independently marks the artifact production-ready.
6. Adobe-native operations remain behind the existing explicit approval and readback boundary.

## Security and architecture
The Canonical Video IR remains authoritative. QA evidence is an immutable run artifact; repair plans are proposals, not permission to execute arbitrary commands. No user-provided string is passed to a shell. The renderer remains responsible for producing verifiable media artifacts.

## Status
This is the first implementation slice of 0.5. Remaining integration and media-analysis acceptance items are intentionally not marked complete.

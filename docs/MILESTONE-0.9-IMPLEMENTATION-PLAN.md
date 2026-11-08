# Motion Studio 0.9 — Editorial assembly and Premiere handoff planning

## Objective
Convert scene-oriented Canonical Video IR into a deterministic, frame-accurate editorial sequence manifest. This is the planning contract for a later Premiere adapter; it does not automate Adobe edits or claim that a sequence was created.

## Scope
- [x] New `@motion-studio/editorial-assembly` package.
- [x] Sequential scene offsets in integer frames.
- [x] Layer clip ranges from scene-relative start/duration frame values.
- [x] Deterministic video, audio and graphics track allocation with overlap-aware lanes.
- [x] Asset URI, checksum and rights-review status propagation.
- [x] Warnings for unresolved media, missing media asset IDs and unreviewed rights.
- [x] Validation for duplicate IDs, invalid clip intervals, invalid tracks and project-duration mismatch.
- [x] Tests and CLI/MCP integration.

## CLI
```bash
motion-studio editorial plan project.json --output assembly.json
motion-studio editorial validate assembly.json
```

## Output contract
The assembly manifest records project/revision, rational frame rate, scene ranges, tracks, clip ranges, source in-points, asset references, source SHA-256 and rights-review state. All timing remains integer frames; conversion to seconds is an adapter concern.

## Governance
- The planner does not write to Premiere or After Effects.
- Asset rights metadata is reported as producer review state, not legal clearance.
- Unresolved source paths and rights-review state remain explicit.
- No source project or media file is mutated.
- A future Adobe adapter must use inspect-only defaults and existing scoped, expiring approvals for edits.

## Deferred
- Actual Premiere sequence creation and FCPXML import/export.
- Transitions, speed changes, nested sequences, multicam and audio mixing.
- Proxy relinking and render-and-replace.
- Live Adobe workstation validation.

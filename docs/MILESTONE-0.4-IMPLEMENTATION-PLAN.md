# Motion Studio 0.4 — Adobe Production Orchestration Plan

Base: Motion Studio 0.3 merged to `main`.

## Phase A — Contracts and policy
- [ ] Define Adobe host status/capability model.
- [ ] Add operation catalog discovery and schema validation.
- [ ] Restrict AE categories and Premiere tool list by workflow.
- [ ] Add one-time preview tokens, approvals, expiry and revision binding.
- [ ] Add local backup/copy requirements and collision refusal.

## Phase B — After Effects scene workflow
- [ ] Convert supported IR text/shape layers into AE operation plans.
- [ ] Discover the live AE operation catalog before every mutation.
- [ ] Create a composition and layers.
- [ ] Apply text style/transform and supported basic keyframes.
- [ ] Save the project and read back the new composition.
- [ ] Add a render-frame proof artifact.

## Phase C — Premiere assembly workflow
- [ ] Inspect and verify Premiere bridge, saved project and backend.
- [ ] Back up the saved project file.
- [ ] Import verified rendered scenes with exact item readback.
- [ ] Create a new sequence from imported project items.
- [ ] Read back active sequence and expected clips.
- [ ] Save the project.
- [ ] Optionally export using a user-selected AME preset and verify the output.

## Phase D — Agent orchestration and tool surface
- [ ] Add high-level Motion Studio MCP tools for Adobe preflight, AE scene apply, Premiere assembly preview/apply and cross-app handoff.
- [ ] Keep upstream tools scoped; do not expose unsafe script.
- [ ] Add receipts, run-state transitions, progress and reconciliation.
- [ ] Keep single-writer leases and sequential host mutations.

## Phase E — Validation
- [ ] Unit and mocked MCP integration tests.
- [ ] Windows/macOS/Linux CI for planning and policy modules; skip licensed Adobe actions on Linux.
- [ ] Fresh Windows machine installation + MCP start.
- [ ] Licensed AE test and Premiere test receipt.
- [ ] Update build report and exact version matrix.

## Exit rule

0.4 is a code/integration milestone, not a final architecture lock. Do not mark Adobe support as production verified until the licensed-host receipts are attached to the release build report.

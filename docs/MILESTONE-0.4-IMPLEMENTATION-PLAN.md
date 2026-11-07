# Motion Studio 0.4 — Adobe Production Orchestration Plan

Base: Motion Studio 0.3 merged to `main`.

## Phase A — Contracts and policy
- [x] Define Adobe host status/capability model.
- [x] Add operation catalog discovery and schema validation.
- [x] Restrict AE categories and Premiere tool list by workflow.
- [x] Add one-time preview tokens, approvals, expiry and revision binding.
- [x] Add local backup/copy requirements and collision refusal.

## Phase B — After Effects scene workflow
- [x] Convert supported IR text/shape layers into AE operation plans.
- [x] Discover the live AE operation catalog before every mutation.
- [x] Create a composition and layers.
- [x] Apply text style/transform and supported basic keyframes.
- [x] Save the project and read back the new composition.
- [x] Add a render-frame proof artifact.

## Phase C — Premiere assembly workflow
- [x] Inspect and verify Premiere bridge, saved project and backend.
- [x] Back up the saved project file.
- [x] Import verified rendered scenes with exact item readback.
- [x] Create a new sequence from imported project items.
- [x] Read back active sequence and expected clips.
- [x] Save the project.
- [x] Optionally export using a user-selected AME preset and verify the output.

## Phase D — Agent orchestration and tool surface
- [x] Add high-level Motion Studio MCP tools for Adobe preflight, AE scene apply, Premiere assembly preview/apply and cross-app handoff.
- [x] Keep upstream tools scoped; do not expose unsafe script.
- [x] Add receipts, run-state transitions, progress and reconciliation.
- [x] Keep single-writer leases and sequential host mutations.

## Phase E — Validation
- [x] Unit and mocked MCP integration tests.
- [x] Windows/macOS/Linux CI for planning and policy modules; skip licensed Adobe actions on Linux.
- [ ] Fresh-machine install/upgrade/repeat-install/uninstall smoke tests in isolated Windows/macOS/Linux CI homes (Windows and Ubuntu pass; macOS validation is pending).\n- [ ] Real user-profile host MCP startup on Windows.
- [ ] Licensed AE test and Premiere test receipt (requires a licensed desktop host).
- [x] Update validation status and exact CI matrix evidence.

## Exit rule

0.4 is a code/integration milestone, not a final architecture lock. Do not mark Adobe support as production verified until the licensed-host receipts are attached to the release build report.

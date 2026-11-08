# Motion Studio 0.5 — Stateful Agent Runtime, QA and Repair

**Base:** 0.4 Adobe production-orchestration branch.  
**Status:** In progress.  
**Primary outcome:** Move Motion Studio from a set of workflow primitives to a durable, resumable production runtime that can coordinate specialist agents, preserve evidence and execute bounded, reviewable repairs.

## Product outcome

A user supplies a brief and assets. Motion Studio builds a Canonical Video IR project, creates a production run, dispatches specialist work through explicit agent contracts, executes the dependency graph, records every artifact and decision, performs structured QA, and either delivers a verified export or produces an actionable blocked/repair report.

The runtime must be useful without any particular AI provider. Agent execution is an adapter boundary: local harnesses/providers can be plugged in without changing the IR, run journal or policy model.

## Scope

### 1. Durable production runs
- Append-only, project-scoped run journal with monotonically increasing revisions.
- Recover run state from events after process restart.
- Idempotent event/task submission and duplicate conflict detection.
- Explicit states for queued, running, waiting-for-approval, blocked, retryable failure, terminal failure and delivered.
- Persist task attempts, inputs, outputs, tool calls, approvals, timestamps and provenance.

### 2. Specialist agent runtime
- Versioned role contracts: executive producer, script/storyboard, art director, asset producer, typography, scene designer, engine specialist, editor, sound, QA and repair.
- Provider-neutral invocation request/result schemas.
- Capability-based tool grants scoped to one project, run and task.
- Per-task idempotency keys, bounded execution time, cancellation and normalized failures.
- Agents return proposals/artifacts/evidence; they do not silently edit core contracts, permissions, dependencies or secrets.
- Host-specific invocation adapters remain separate for Z Code, Claude Code, Codex and other compatible harnesses.

### 3. Execution scheduler
- Validate and execute the existing DAG in dependency order.
- Persist task state before and after external side effects.
- Single-writer locks for Adobe hosts and default render concurrency of one.
- Resume interrupted runs by reconciling external host state and artifact checksums; never blindly replay uncertain non-idempotent actions.
- Retry only classified transient/idempotent operations, with explicit attempt limits.

### 4. Evidence-based QA
- Structured technical, visual, typography, audio, accessibility and creative findings.
- Defect identity, severity, confidence, scene/frame/time ranges, evidence references, repair owner and retest scope.
- Distinguish automated observations from human review and model judgments.
- Delivery gate requires all blocking defects resolved and final export independently verified.

### 5. Bounded repair loop
- Convert approved findings into minimal repair tasks scoped to affected scenes/layers/time ranges.
- Re-render only affected outputs where dependency and cache evidence permits.
- Retest repaired regions and run full delivery regression.
- Enforce configurable repair-cycle/attempt budgets; escalate unresolved or ambiguous defects to the user.
- No autonomous destructive Adobe timeline edits without preview and explicit approval.

### 6. Project memory and provenance
- Separate project memory, user style preferences and shared validated patterns.
- Store source/evidence references, not copies of licensed assets unless permitted.
- Record which preferences influenced a project and allow user review/export/deletion.
- Learning changes remain proposals; executable code, permissions, secrets, dependencies and core contracts require human approval.

## Out of scope for 0.5
- Cloud rendering by default or multi-tenant hosted execution.
- Unattended social publishing or distribution.
- Automatic purchase, sign-in, licensing or activation of Adobe products.
- Editing opaque `.aep` / `.prproj` binaries.
- Unbounded self-modification or autonomous promotion of executable code.
- Claiming multimodal QA accuracy without calibrated evaluation sets and human review.

## Non-negotiable invariants
1. Canonical Video IR remains the creative source of truth.
2. Premiere owns editorial assembly; After Effects owns specialist comps; HyperFrames/GSAP owns programmable 2D; Blender/Three.js own 3D; FFmpeg/FFprobe owns media processing and independent inspection.
3. All external actions use fixed executables/argument arrays or scoped MCP calls; no shell interpolation.
4. Every side effect is attributable to a run, task, approval and evidence receipt.
5. A task with unknown side-effect outcome is reconciled before retry.
6. No delivery without a verified final-export artifact and passing blocking QA.
7. Local runtime binds to loopback and requires authentication for protected endpoints.

## Acceptance criteria
- Kill/restart test resumes a run from its journal without losing or duplicating completed tasks.
- Duplicate task/event submissions are idempotent; conflicting reuse is rejected.
- Capability tests prove an agent cannot invoke ungranted tools or cross project boundaries.
- DAG scheduler respects dependencies, single-writer leases and concurrency policy.
- QA findings map to scoped repair tasks; repair cycles and attempts are bounded.
- A repaired region is retested and full delivery regression is required.
- A full sample production run produces inspectable run history, artifact checksums, QA report and final delivery receipt.
- Cross-platform CI passes on Windows/macOS/Linux and supported Node LTS versions.
- Real Adobe host acceptance remains separately gated by licensed-host receipts from 0.4.

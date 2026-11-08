# Motion Studio 0.5 — Implementation Plan

## Phase 0 — Contracts and architecture
- [x] Define milestone scope and acceptance criteria.
- [x] Add ADR for durable local run journal and recovery semantics.
- [x] Define agent request/result and capability contracts in the provider-neutral agent runtime.
- [ ] Define QA finding, repair task and evidence schemas.

## Phase 1 — Durable run store
- [x] Append-only JSONL event journal, project-scoped revisions and event idempotency.
- [x] Replay/recovery of event history, including incomplete final-line truncation.
- [ ] Atomic metadata snapshots and corruption recovery policy.
- [x] Tests for journal reopen/replay, duplicate events, revision conflicts, concurrent append ordering and partial writes.

## Phase 2 — Agent runtime
- [x] Role registry and versioned agent contracts.
- [x] Capability grants scoped to the project/run/task invocation.
- [x] Provider-neutral dispatcher with idempotency, deadlines and uncertain-outcome reconciliation.
- [ ] Harness adapters and normalized failure taxonomy.
- [x] Tests for capability denial, project isolation, duplicate execution, timeout and reconciliation. (Provider cancellation adapters remain open.)

## Phase 3 — Scheduler and resumability
- [ ] DAG scheduler with persisted task lifecycle.
- [ ] Concurrency limits and per-host single-writer leases.
- [ ] Side-effect reconciliation before retries.
- [ ] Restart/recovery integration tests.

## Phase 4 — QA and repair
- [ ] Versioned multimodal QA finding schema and evidence store.
- [x] Defect-to-repair planner with scene/frame scope and owner grouping.
- [x] Bounded repair cycles and task budget enforcement in the planner.
- [x] Repair outcome gate requires evidence and passing retests for every linked defect. Full delivery regression integration remains open.

## Phase 5 — Project memory and production receipts
- [ ] Project-scoped memory API with provenance and user controls.
- [ ] Separate project/user/shared memory namespaces.
- [ ] End-to-end sample run with inspectable timeline and artifacts.
- [ ] Security, data isolation, reliability and performance validation.

## Exit gate
0.5 is complete only when a full sample production run survives process restart, produces verifiable artifacts and QA evidence, respects tool grants and concurrency limits, and cannot deliver with unresolved blocking defects. Mocked agent calls alone are not end-to-end acceptance.

# Motion Studio 0.5 — Implementation Plan

## Phase 0 — Contracts and architecture
- [x] Define milestone scope and acceptance criteria.
- [ ] Add ADR for durable local run journal and recovery semantics.
- [ ] Define agent request/result and capability contracts.
- [ ] Define QA finding, repair task and evidence schemas.

## Phase 1 — Durable run store
- [ ] Append-only JSONL event journal, revision checks and idempotency.
- [ ] Replay/recovery into production-run state.
- [ ] Atomic metadata snapshots and corruption recovery policy.
- [ ] Tests for restart, duplicate events, revision conflicts and partial writes.

## Phase 2 — Agent runtime
- [ ] Role registry and versioned agent contracts.
- [ ] Capability grants scoped by project/run/task.
- [ ] Provider-neutral dispatcher with idempotency and deadlines.
- [ ] Harness adapters and normalized failure taxonomy.
- [ ] Tests for policy denial, duplicate execution, timeout and cancellation.

## Phase 3 — Scheduler and resumability
- [ ] DAG scheduler with persisted task lifecycle.
- [ ] Concurrency limits and per-host single-writer leases.
- [ ] Side-effect reconciliation before retries.
- [ ] Restart/recovery integration tests.

## Phase 4 — QA and repair
- [ ] Versioned multimodal QA finding schema and evidence store.
- [ ] Defect-to-repair planner with scene/frame scope.
- [ ] Bounded repair cycles and per-task retry budget.
- [ ] Retest repaired scope and full regression before delivery.

## Phase 5 — Project memory and production receipts
- [ ] Project-scoped memory API with provenance and user controls.
- [ ] Separate project/user/shared memory namespaces.
- [ ] End-to-end sample run with inspectable timeline and artifacts.
- [ ] Security, data isolation, reliability and performance validation.

## Exit gate
0.5 is complete only when a full sample production run survives process restart, produces verifiable artifacts and QA evidence, respects tool grants and concurrency limits, and cannot deliver with unresolved blocking defects. Mocked agent calls alone are not end-to-end acceptance.

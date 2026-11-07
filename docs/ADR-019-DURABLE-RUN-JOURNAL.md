# ADR-019: Durable local production-run journal

**Status:** Accepted for 0.5 implementation; subject to validation.  
**Date:** 2026-11-07

## Context

Motion Studio's current orchestrator can model state transitions and dependency graphs, but production runs are in-memory objects. A desktop process restart can therefore lose the authoritative run timeline, task idempotency state and provenance needed to decide whether an external render or Adobe mutation is safe to retry.

0.5 needs durable recovery without adding a mandatory database service or making the project IR dependent on one storage engine.

## Decision

Use an append-only, project-scoped JSON Lines event journal as the first durable persistence adapter.

- Every event has a unique event ID, run ID, monotonically increasing per-run revision, type, timestamp and structured payload.
- Appends are serialized within the local runtime, flushed with file-handle sync, and checked against the expected revision.
- Replaying the journal reconstructs run history; snapshots may be added later as a derived cache, never as the source of truth.
- Exact duplicate event IDs are idempotent; reusing an ID with different content is a hard conflict.
- An incomplete final line from a process crash is truncated to the last complete newline. Corruption in a complete event is fail-closed.
- Unknown external side-effect outcomes remain in a reconciliation-required state. The journal does not imply that an action is safe to replay.
- The storage interface is provider-neutral so SQLite or another transactional store can be introduced later behind an ADR if concurrent writers, query scale or retention needs justify it.

## Consequences

**Positive**
- No external database daemon or native addon is required.
- Human-inspectable audit trail and straightforward backup/export.
- Deterministic replay and easy unit/integration testing.
- Compatible with local-first desktop distribution and constrained machines.

**Trade-offs**
- One writer per journal is required.
- Large journals need compaction/snapshot policy in a later phase.
- Cross-process locking and crash semantics must be validated before multiple runtime processes are supported.
- Sensitive payloads must be redacted or stored as secure references; do not write credentials or raw secrets into JSONL.

## Rejected alternatives

- **SQLite as a mandatory first dependency:** stronger query and transaction support, but adds native packaging and migration complexity before measured need.
- **Mutable JSON run snapshots only:** simple, but vulnerable to torn writes and loses the append-only audit history.
- **Remote database:** violates the local-first default and introduces network availability and privacy dependencies.

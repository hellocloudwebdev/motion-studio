# Motion Studio 0.6 — Verified production orchestration

## Objective
Turn the existing render/QA state machine into a fail-closed, host-aware production workflow. A stage may advance only when its target host has supplied explicit readiness evidence; Premiere assembly and final export additionally require a time-bounded approval scoped to the exact project and run.

## Implemented in this branch
- [x] Host-readiness evaluation for every engine in a route plan, plus mandatory Premiere and FFmpeg delivery checks.
- [x] Fail-closed behavior when a host check is absent, incomplete or unknown.
- [x] Scoped approval validation for After Effects comps, Premiere assembly and final export.
- [x] Production-run transitions now require verified host readiness and matching approval records before assembly and export.
- [x] Approval records are persisted into run history and transition events.
- [x] Adobe edit-enabled MCP calls require a short-lived approval bound to project, run, app, exact tool name and SHA-256 digest of exact arguments.
- [x] CLI `preflight` command and MCP tools for host readiness and stage authorization.
- [x] Unit tests for missing host evidence, unknown engines, expired/mismatched approvals and altered tool arguments.

## CLI
```bash
motion-studio preflight project.json --host-checks host-checks.json
```

The host-checks JSON is evidence gathered from local software/host checks. Example shape:

```json
{
  "hyperframes": { "available": true },
  "afterEffects": { "serverConnected": true, "contextAvailable": true },
  "premiere": { "serverConnected": true, "hostVerified": true },
  "ffmpeg": { "available": true }
}
```

The command exits with status 3 when any required host is not verified. It does not invent successful checks or launch editors.

## Security and approval model
- Adobe starts read-only/inspect-only by default.
- An edit-enabled Adobe MCP client refuses tool calls without an approval record.
- The approval must match the project ID, run ID, Adobe application, tool name and exact argument digest, and expire within one hour (10 minutes by default).
- Premiere and final-export run transitions require matching project/run/stage approvals and host readiness.
- Unsafe script execution remains disabled. No user input is interpolated into shell commands.
- Approval records are governance/audit data, not cryptographic identity proof. A trusted local host/UI must obtain the producer's confirmation before constructing an approval record.

## Explicit boundaries / not yet complete
- This milestone does not execute an end-to-end After Effects comp, create a Premiere sequence, or export a finished film on a licensed desktop workstation.
- Upstream Adobe MCP tool availability and host-specific behavior still require live validation on Windows/macOS with the licensed applications open.
- The new approval API constrains Motion Studio's edit-enabled client; it cannot secure direct use of upstream MCP servers outside Motion Studio.
- Artifact readback and final-export verification remain required before a run can enter `delivered`.
- No automatic installation or licensing of Adobe software is attempted.

## Acceptance criteria
- Missing or incomplete engine evidence blocks preflight.
- Unknown engine adapters block preflight.
- Mismatched, expired or argument-altered approvals are rejected.
- Run state cannot advance to assembly/export without the required approval and host readiness.
- Delivery still requires a separately recorded verified final-export artifact.
- CI passes across the supported Node/OS matrix.

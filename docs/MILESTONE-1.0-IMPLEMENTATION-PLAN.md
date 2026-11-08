# Motion Studio 1.0 — Premiere interchange and governed sequence handoff

## Objective
Turn the validated editorial assembly manifest into a deterministic, inspectable interchange package that Premiere Pro can import, while preserving timing, media provenance and producer-review state.

## Scope
- [ ] Add a dedicated Premiere interchange package with a documented FCPXML export contract.
- [ ] Convert integer-frame positions using the project's exact rational frame rate; never round through floating-point seconds.
- [ ] Map media clips and overlap-aware tracks into an explicit sequence structure.
- [ ] Resolve relative media paths only against an explicit asset root; reject traversal and unsupported URI schemes.
- [ ] Preserve clip IDs, source in-points, source hashes and rights-review state in a sidecar manifest.
- [ ] Fail closed on unresolved media, unsupported clip kinds, invalid sequence ranges and ambiguous frame-rate data.
- [ ] Add CLI export/validate commands and MCP planning/export tools; export remains a local file-generation action.
- [ ] Add golden XML, escaping, path traversal, rational timing, multi-track and round-trip validation tests.
- [ ] Document Premiere import steps and limitations.

## Governance
- Exporting interchange files does not launch Premiere, import a sequence, modify a project or perform edits.
- Any later live Adobe write operation must use existing project/run/stage-scoped approvals and per-operation tool/argument approvals.
- Rights metadata is carried through as producer audit state, not legal clearance.
- No media source is modified; export writes only to the requested output location.

## Deferred
- Direct Premiere sequence creation through UXP/CEP MCP.
- Proxy relinking and render-and-replace.
- Transitions, nested sequences, multicam, retiming, effects and advanced audio mixing unless explicitly represented by supported IR semantics.
- Licensed Adobe workstation validation and end-to-end export certification.

# Milestone 1.1 — Autonomous creative production pipeline

## Objective
Connect the existing creative roles through explicit, provider-neutral contracts. A natural-language idea must become a production brief, research evidence (when required), creative direction, script, storyboard, design system and validated Canonical Video IR.

## Implemented in the first 1.1 slice
- `@motion-studio/production-planning`: provider-neutral production brief contract.
- Stable brief IDs derived from the idea unless the caller supplies an ID.
- Explicit optional fields for audience, purpose, duration, language, platform, aspect ratio, brand guidelines, references, supplied assets and constraints.
- Open questions are preserved rather than silently guessed; they are non-blocking until a later policy marks a field essential.
- Research is included in the workflow DAG only when the brief explicitly requires it.
- Deterministic stage dependency graph for creative direction → script → storyboard/design system → Canonical Video IR.
- Unit tests for normalization, validation, custom dimensions, optional fields and workflow dependencies.

## Remaining 1.1 work
- [ ] Connect actual provider-backed agents to each stage with typed input/output contracts.
- [ ] Add claim-level source evidence and unsupported-claim tracking for research.
- [ ] Generate creative concepts, narrative, hook, pacing and CTA from a brief.
- [ ] Generate narration/on-screen copy separately with speaking-rate and frame timing checks.
- [ ] Generate storyboard scene/layer specifications and asset/audio cues.
- [ ] Generate brand tokens and validate font installation/glyph coverage.
- [ ] Compile approved planning artifacts into Canonical Video IR and run the existing project validator.
- [ ] Persist revisions, approval state and artifact provenance in the run journal.
- [ ] Add end-to-end intake → IR fixture and CLI/MCP entry points.

## Boundaries
The package currently defines and validates contracts and a workflow DAG; it does not call an LLM, create research evidence or claim that an agent ran. Unknown brief fields remain unknown. Rendering remains blocked until a validated IR and the required human approval are present.

## Exit gate
A user supplies an idea and receives a complete, validated, render-ready Canonical Video IR without manually constructing project JSON. This milestone is not complete until the remaining checklist and an end-to-end acceptance fixture pass.

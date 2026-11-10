# Milestone 1.1 — Autonomous creative production pipeline

## Objective
Connect the creative roles through explicit, provider-neutral contracts. A natural-language idea becomes a production brief; host-native creative agents produce research, creative direction, script, storyboard and design-system artifacts; Motion Studio validates and compiles those artifacts into Canonical Video IR.

## Implemented in this PR
- [x] `@motion-studio/production-planning`: provider-neutral production brief contract.
- [x] Stable brief IDs, normalized optional inputs and strict duration/aspect-ratio validation.
- [x] Open questions are preserved instead of silently inventing audience, purpose, duration, language, platform or format.
- [x] Deterministic workflow DAG for research (when required), creative direction, script, storyboard, design system and Canonical Video IR.
- [x] Research evidence validator: source identity/URL validation, unique source and claim IDs, claim-to-source references and unsupported-claim rejection.
- [x] Planning artifact validators for creative direction, narration/on-screen copy, storyboard scenes/layers and design tokens/fonts.
- [x] Canonical Video IR compiler: resolved audience/duration/aspect ratio, rational frame-rate validation, storyboard frame alignment, brand tokens, assets, delivery target and provenance.
- [x] Compiler runs the existing Canonical Video IR project validator before returning a project.
- [x] CLI: `create`, `validate`, `workflow`, `validate-artifacts`, `compile`.
- [x] MCP tools: `video.create_production_brief`, `video.validate_production_brief`, `video.plan_creative_workflow`, `video.validate_planning_artifacts`, `video.compile_planning_artifacts`.
- [x] Unit and CLI integration tests for intake, evidence validation, frame-accurate compilation, custom dimensions, rational frame rates and invalid-input failure.

## CLI usage

Create the brief and workflow plan:
```bash
npm run intake -- create idea.json --output production-brief.json --workflow creative-workflow.json
```

Validate an existing brief:
```bash
npm run intake -- validate production-brief.json
```

Validate the provider-generated planning artifacts:
```bash
npm run intake -- validate-artifacts planning.json
```

Compile approved planning artifacts into Canonical Video IR:
```bash
npm run intake -- compile planning.json --output canonical-video-ir.json
```

The planning input file for `validate-artifacts` and `compile` has this shape:
```json
{
  "brief": {},
  "creativeDirection": {},
  "script": {},
  "storyboard": { "scenes": [] },
  "designSystem": {},
  "researchEvidence": null
}
```

A research-required brief must include `researchEvidence` with claim-level source references. The compiler does not assert that a source is truthful or legally cleared; it checks traceability and structure.

## Host-native agent integration contract
The agent role definitions in `agents/` remain the prompt/role layer for the connected AI host. The workflow DAG and artifact schemas are the stable handoff contract. Each host must:
1. Read the approved brief and only the dependency outputs for its stage.
2. Return the matching JSON artifact and preserve unknowns/assumptions explicitly.
3. Never invent factual claims, product capabilities, testimonials, source citations or usage rights.
4. Pass artifacts to `validate_planning_artifacts` before IR compilation.
5. Keep human approval before rendering, Adobe writes and final delivery.

The current implementation provides provider-neutral contracts, validators, compiler, CLI and MCP surfaces. It does **not** call a model provider itself, and it does not claim that host-native agents have executed. AI-host orchestration and full end-to-end idea-to-render acceptance remain integration work.

## Remaining 1.1 acceptance work
- [ ] Connect and execute the agent DAG in each supported host (Claude Code, Codex, Z Code and generic MCP) with typed input/output exchange.
- [ ] Add claim-level retrieval provenance (retrievedAt, publisher, exact supporting passages/locations) and source freshness policy.
- [ ] Add script timing analysis using language-aware speaking-rate estimates and scene-level narration alignment.
- [ ] Generate storyboards from script beats and enforce complete asset/audio cue coverage.
- [ ] Validate installed fonts and glyph coverage on the render host before rendering.
- [ ] Persist brief/artifact revisions, approvals and artifact hashes in the run journal.
- [ ] Add five acceptance-project fixtures and a full idea → agents → IR → render → QA → delivery run.
- [ ] Demonstrate actual HyperFrames render and final delivery from a compiled planning bundle.

## Boundaries
The planning package defines and validates contracts and compiles supplied artifacts; it does not call an LLM, retrieve external research or claim an agent ran. Unknown brief fields remain unknown. Unsupported or malformed artifacts fail closed. Rendering remains blocked until a validated IR and required human approval are present. User-owned/licensed Adobe products are never silently installed or activated.

## Exit gate
A user supplies an idea and receives a complete, validated, render-ready Canonical Video IR through the configured AI host without manually constructing project JSON; the same run then produces a verified final video and delivery evidence. This PR closes the deterministic planning/IR contract layer, not the complete host execution and runtime acceptance gate.

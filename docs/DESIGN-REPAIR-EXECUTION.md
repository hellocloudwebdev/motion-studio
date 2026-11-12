# Design — Defect → Patch → Rerender → Retest Repair Execution Loop (P1.3)

**Status:** Adopted design record for implementation. Produced 2026-11-11. Satisfies work package P1.3 of the master roadmap and the repair-cycle requirements of `docs/ORCHESTRATION-DESIGN-0.3.md`.

## 1. Context and constraints

- Local-first, single machine, render concurrency 1 (`AGENTS.md`; orchestrator hard-codes `maxWorkers: 1`).
- Dominant quality attributes: (1) provenance/evidence integrity — every repair traceable to defect IDs, patch content, IR hashes; delivery already hash-binds the master to the IR; (2) determinism — no LLM-authored field values, no timestamps inside IR payloads; (3) bounded autonomy — the loop may change only the Canonical Video IR, within a documented cycle budget, and must escalate rather than improvise.
- Existing scaffolding: `createRepairPlan` (instruction strings only), `persistQaRecord` (accumulates `project.qa.repairHistory`), orchestrator state machine (never persisted/wired), `configs/quality-gates.json` (loaded by no code), HyperFrames CLI 0.8.86 supports `render --composition <path>`, scene files are standalone self-contained compositions, scene boundaries are hard cuts by construction (`LAYER_EXCEEDS_SCENE_DURATION` is a validation error).

## 2. Decision table

| # | Decision | Choice | Rationale | Risk |
|---|---|---|---|---|
| D1 | Patch representation | Plain JSON envelope + hand-rolled `validateRepairPatch` in `packages/core/src/patch.mjs` (same style as `validate-project.mjs`). No zod in core; `project.schema.json` stays dead (later cleanup). | Codebase convention; core has zero runtime deps. | Two sources of truth if schema file is revived — point it at `patch.mjs`. |
| D2 | Patch authorship | Deterministic, code-driven patch generation (`createPatchFromDefects`). No LLM-generated values. | Repairs must be deterministic and auditable; visual critic stays advisory. | Lower coverage of creative defects — accepted; those escalate. |
| D3 | Rerender scope | Hybrid. Targeted = full recompile from patched IR (cheap), then `render --composition scenes/<id>.html` per affected scene. Fall back to whole-project when: `targetedRerender:false`, any defect lacks sceneId, affected scene has non-hyperframes tasks, `--composition` runtime probe fails, or defect family requires the full master (audio-mix retests run on the mixed master). | Scene HTML files are already standalone compositions; valid IR guarantees hard scene boundaries; CLI supports `--composition`. | Segment/full frame consistency unverified until the consistency probe runs — mitigated: master is always fully re-rendered after an accepted cycle. |
| D4 | Master refresh | No FFmpeg concat in v1. After a cycle's retest passes, refresh the master with one full proven-path render of the patched IR (hash-bound into delivery). | `finalizeMedia` has no concat; failed attempts (the common case) cost only segment renders. | Full render per accepted cycle remains O(project). |
| D5 | Retry policy | `configs/quality-gates.json → repair.maxCycles = 2` is the single authoritative value (loaded by `loadQualityGates`, consumed by orchestrator run creation, repair executor, CLI). `createRepairPlan`'s `min(3,…)` stays a hard ceiling. Policy: 2 automatic cycles, then mandatory escalation. | Resolves the roadmap's 2-vs-3 conflict in favor of the documented default. | Loader range-validates 1..3 and records the effective policy in `run-state.json`. |
| D6 | Where the loop lives | New package `packages/repair-executor`; orchestrator gains `quality-gates.mjs` + `run-state.mjs` as pure modules; CLI gains `repair`. Dependency direction: `repair-executor → {core, orchestrator, render-manager}`; no cycles. | Keeps policy out of rendering and process-driving out of the pure state machine. | One more package — justified. |
| D7 | Cycle-count authority | `project.qa.repairHistory` in the Canonical IR is the authoritative repair ledger; `run-state.json` is an operational cache recomputed from the ledger at loop start. | The IR is canonical, packaged and hash-bound. | Ledger growth bounded by per-run runId prefix. |

## 3. Patch model

### 3.1 Patch envelope

```json
{
  "schemaVersion": "1.0.0",
  "patchId": "patch-<runId>-a<attempt>",
  "createdAt": "ISO-8601",
  "basedOnIrSha256": "<sha256 of canonical IR before patching>",
  "attempt": 1,
  "maxCycles": 2,
  "defectIds": ["render-render_not_verified", "qa-003"],
  "operations": [
    {
      "op": "set_typography",
      "target": { "sceneId": "scene-02", "layerId": "scene-02-title" },
      "fields": { "family": "Arial", "sizePx": 36, "safeArea": true },
      "reason": "FONT_UNSPECIFIED"
    }
  ]
}
```

Validation rules (`validateRepairPatch(patch, project)` → `{valid, issues[]}`): schemaVersion `1.0.0`; unique non-empty patchId; integer `attempt` with `0 ≤ attempt < maxCycles`; `defectIds` non-empty and resolvable in the current QA result; `op` ∈ the six types; `target` resolves to exactly one node; `reason` must be a defect code present in `defectIds` resolution; per-op field whitelists/domains; unknown fields/wrong types/out-of-domain values are issues, never silently dropped; `basedOnIrSha256` must equal the current IR hash (CAS — stale patches rejected).

Application: `structuredClone(project)` → sequential ops (each re-resolves its target against the patched clone) → `validateProject(patched)` valid **and** no NEW issue codes vs the pre-patch baseline (no-regression rule) → `patchedIrSha256` (same canonicalization as the render manifest's `projectIrSha256`).

### 3.2 Operation types

| Op | Target | Fields (whitelist + domains) | Notes |
|---|---|---|---|
| `set_typography` | `{sceneId, layerId}` (text layer) | `family` (1..80 chars, must be in `project.brand.fonts`), `sizePx` (int ≥ 18), `weight` (int 100..900), `lineHeight` (0.8..3), `alignment` (left\|center\|right), `maxLines` (int ≥ 1), `safeArea` (must be `true` — never disables safe area) | ≥18 floor matches the QA threshold. |
| `set_transform` | `{sceneId, layerId}` | `x`, `y` (ints ≥ 0, inside canvas safe area), `width`, `height` (ints > 0, fits canvas), `scale` (0.1..4), `rotation` (-180..180), `opacity` (0..1) | Primary `TEXT_OVERFLOW_ESTIMATED` fix (post-check text fit). |
| `set_motion` | `{sceneId, layerId}` | `preset` ∈ {none, fade, fade-up, slide-up, float, slide-left, slide-right, zoom, rotate} (adapter's implemented set), `durationFrames` (int 1..scene.durationFrames), `delayFrames` (int ≥ 0 ≤ scene end), `easing` ∈ adapter's allowed list | Enumerating the adapter's actual sets makes patches renderable. |
| `set_timing` | `{sceneId, layerId?}` or `{scope:"project"}` | layer/scene: `startFrame` (int ≥ 0), `durationFrames` (int > 0, containment-checked); project: `totalDurationFrames` (int > 0, must equal Σ scene durations) | Project form is a canonicalization (compiler derives duration from scene sum) — fixes `CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT` without changing output. |
| `rebind_asset` | `{sceneId, layerId}` or `{sceneId, cueIndex}` / `{trackIndex}` | `assetId` (must exist in `project.assets`, kind-compatible, sha256-verified file on disk if hashed) | Can only rebind to an already-declared verified asset. Missing media is never invented. |
| `set_audio_cue` | `{sceneId, cueIndex}` or `{trackIndex}` | `offsetFrames` (int ≥ 0), `durationFrames` (int > 0), `volume` (0..4), `fadeInFrames`, `fadeOutFrames` (non-negative, ≤ duration, sum ≤ duration) | Bounded gain/placement changes; re-measured by retest. |

No operation can create/delete scenes or layers, change text content, canvas/frame-rate/delivery contracts, `schemaVersion`/ids/provenance, or touch any file outside the IR.

### 3.3 Defect-code → repair mapping (authoritative)

Legend: **AUTO** = deterministic patch op generated without human input. **COND** = conditional auto (only when the stated precondition holds; otherwise reportable-only). **REPORT** = recorded and escalated, never patched.

| Defect code (source) | Verdict | Repair op / reason |
|---|---|---|
| `FONT_UNSPECIFIED` (qa.mjs) | AUTO | `set_typography {family}` from `project.brand.fonts`. |
| `TEXT_TOO_SMALL` (qa.mjs) | AUTO | `set_typography {sizePx: max(18, type-scale caption size)}`; if raising size breaks fit, pair with `set_transform` box enlargement; if neither fits → REPORT + escalate. |
| `TEXT_SAFE_AREA_DISABLED` (qa.mjs) | AUTO | `set_typography {safeArea: true}`; add `set_transform` if geometry also violates. |
| `TEXT_OUTSIDE_SAFE_AREA` (compiler) / `OCR_TEXT_OUTSIDE_SAFE_AREA` | COND | `set_transform` moving the box inside the safe area; OCR variant: owning scene from sample time, layer matched by box overlap only when exactly one layer matches; ambiguous → REPORT. |
| `TEXT_OVERFLOW_ESTIMATED` (compiler) | COND | Priority: (1) `set_transform` enlarge box within safe area; (2) `set_typography` reduce sizePx (never < 18); (3) REPORT — text content is never patched. |
| `ASSET_REFERENCE_MISSING` / `ASSET_FILE_MISSING` (qa.mjs, compiler) | COND | `rebind_asset` only when a same-kind hash-verified candidate already exists in `project.assets`. Missing media is never invented; otherwise REPORT (asset-producer). |
| `EXTERNAL_ASSET` (compiler) | REPORT | Replacing external media is a rights/provenance decision. |
| `NON_HYPERFRAMES_LAYER`, `UNSUPPORTED_LAYER_KIND` (compiler) | REPORT | Engine-routing changes mid-repair would silently substitute a weaker renderer. |
| `ENGINE_UNAVAILABLE`, `CAPABILITY_UNMAPPED` (route) | REPORT | Host/environment, not an IR defect. |
| `PROJECT_MISSING` | REPORT | Input error. |
| `RENDER_MANIFEST_MISSING`, `OUTPUT_PATH_MISSING`, `OUTPUT_EMPTY`, `OUTPUT_CHECKS_MISSING`, `FRAME_EVIDENCE_MISSING` | REPORT | Render-infrastructure failures; re-render is the loop's own action. |
| `RENDER_NOT_VERIFIED` | REPORT (derived) | Repaired implicitly when its causes are; only remaining defect at the limit → escalate. |
| `CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT` | AUTO | `set_timing {scope:"project", totalDurationFrames: Σ scene.durationFrames}` — canonicalization that cannot change rendered output. |
| `CHECK_FAILED_HYPERFRAMESCHECKPASSED` | REPORT | Underlying typography/safe-area findings arrive as compiler warnings and have their own rows. |
| `CHECK_FAILED_DIMENSIONSMATCH / FRAMERATEMATCH / DURATIONWITHINONEFRAME / HASVIDEO / NONEMPTY` | REPORT | Renderer/FFmpeg/toolchain contract failures. |
| `FRAME_DECODE_FAILED_n` | COND | No patch; allow exactly one re-render retry (transient); recurring at the same frame → escalate. |
| `BLOCKING_BLACK_FRAME_SEGMENT` (interior) | COND | When an owning layer's coverage gap explains the range: `set_timing` extend / `set_transform` cover. Otherwise REPORT. |
| `BLACK_FRAME_SEGMENT` at clip edges | REPORT | Possibly intentional fade (detector message). |
| `FROZEN_FRAME_SEGMENT` | COND | `set_motion {preset:"float"}` on the owning scene's static content layer when the hold is not an intentional design hold (the P1.1 fix, promoted to a patch op). Ambiguous ownership → REPORT. |
| `PERCEPTUAL_DUPLICATE_FRAMES` | COND | Same as FROZEN; requires scene attribution. |
| `AUDIO_SILENCE_SEGMENT` | COND | `set_audio_cue` shifting/extending the narration cue into the gap when the gap is attributable to cue placement and stays within script/timing policy; intentional reviewed pauses are REPORT. Audio retest runs on a mixed segment. |
| `AUDIO_PROGRAM_TOO_QUIET` / `AUDIO_PROGRAM_TOO_LOUD` | COND | `set_audio_cue {volume}` with a cumulative gain budget of ±6 dB across all cycles of a run; exceeded → REPORT. |
| `AUDIO_TRUE_PEAK_EXCEEDED` | COND | Volume reduction only (never makeup gain), same ±6 dB budget. |
| `AUDIO_STREAM_MISSING` | REPORT | Delivery/mix configuration, not an IR defect. |
| `OCR_FRAME_FAILED`, `OCR_BOTTOM_TEXT_REVIEW`, `OCR_REQUIRED_UNAVAILABLE` | REPORT | Evidence-gap / human-review / environment items. |
| Visual-critic findings | REPORT (advisory) | Never gate, never patch. |

Repair-history record (written via `persistQaRecord` with `patch` + `retestScope` passthrough):

```json
{
  "runId": "run-<projectId>-<ts>", "attempt": 1, "status": "repair-required",
  "patch": { "patchId": "patch-…-a1", "operations": ["…as authored…"],
             "basedOnIrSha256": "…", "patchedIrSha256": "…" },
  "defectIds": ["…"],
  "retestScope": { "sceneIds": ["scene-02"], "checks": ["mediaAnalysisPassed"],
                   "snapshotTimes": [2.0, 4.033, 6.0] },
  "retestResult": "passed", "escalation": null
}
```

## 4. Execution flow

### 4.1 Components

```
CLI `repair` → packages/repair-executor (runRepairLoop / executeRepairCycle)
  ├─ orchestrator/quality-gates.mjs   loadQualityGates() → maxCycles=2
  ├─ orchestrator/run-state.mjs       loadRunState / saveRunState / invalidateOnInputChange
  ├─ orchestrator/index.mjs           createProductionRun / transitionRun / recordArtifact
  ├─ core/patch.mjs                   classifyDefects / createPatchFromDefects / validateRepairPatch / applyRepairPatch
  ├─ render-manager                   renderHyperFramesProject (scoped + full)
  └─ core                             evaluateRenderEvidence / createRepairPlan / persistQaRecord / runVisualCritic (advisory)
Escalation artifacts: projects/<id>/escalations/escalation-<runId>-a<n>.json (+ .md)
IR backups: projects/<id>/history/revision-<n>-<oldIrSha8>.json
Run state: projects/<id>/run-state.json
```

External-dependency failure behavior: HyperFrames CLI timeout → executor wraps cycle renders in configurable `timeoutMs` (default 20 min); timeout before QA evidence costs no cycle (retried once, then fails the run). Non-zero exit → today's throw path; executor reads on-disk manifest/qa-report for evidence. FFmpeg/FFprobe down → cycle fails without consuming budget. Filesystem writes atomic-by-rename; IR backup before overwrite.

### 4.2 Sequence of one repair cycle

1. **Entry** — `motion-studio repair <project.json> [--max-cycles N] [--no-targeted] [--quality draft] [--dry-run] [--project-root <dir>]`. Load project, `loadQualityGates()`, `loadRunState`. IR hash mismatch vs run-state → invalidate downstream, reset to `planned`.
2. **Run state** — create/resume run; `repairCycles` recomputed from `project.qa.repairHistory` for the current runId (D7), cross-checked against the run object; mismatch → trust the IR ledger. Transitions `draft→planned→rendering`.
3. **Render (or resume)** — reuse a verified render manifest for the exact `projectIrSha256` when input hashes unchanged; else `renderHyperFramesProject(project, {workers:1, quality, repairAttempt:cycles, maxRepairAttempts:gates.maxCycles, throwOnQaFailure:false, …})`. Repair renders force `allowMissingAssetsAsPlaceholders:false`.
4. **Evaluate** — `evaluateRenderEvidence(manifest)` + `runProjectQA(project, routeScenes(project))`; merge defect lists (IR defects first, then render-evidence).
5. **Plan** — `createRepairPlan(mergedQa, {attempt:cycles, maxAttempts:gates.maxCycles})`. `no-action` → exit to delivery path. `escalate` → step 9. `repair-required` → step 6.
6. **Classify + generate** — `classifyDefects` → `createPatchFromDefects` (null when nothing repairable → escalate without burning a render). `--dry-run` prints the patch and stops.
7. **Apply + validate** — `validateRepairPatch` → `applyRepairPatch` → validate + no-new-issues → `patchedIrSha256`. Failure → defect reclassified REPORT, no cycle consumed.
8. **Persist patch** — backup previous `project.json` to `history/revision-<n>-<oldIrSha8>.json`; write patched IR atomically (revision incremented; repairHistory entry pre-staged). Transition `qa→repair` (orchestrator enforces the limit — second lock).
9. **Rerender scoped** — `decideRerenderScope({project, patchedProject, defects, gates, routePlan})` → `{mode:"targeted", sceneIds}` only when `gates.targetedRerender && every defect has sceneId && affected scenes contain only hyperframes tasks && sceneIds non-empty`; else `{mode:"full"}`. Targeted: `renderHyperFramesProject(patched, {sceneIds, renderLabel:"repair-a<attempt>", throwOnQaFailure:false})`. Full: existing path.
10. **Retest** — `computeRetestScope(defects, affectedScenes, {fps})`: rerun union of failed checks + always the standard contract checks + `mediaAnalysisPassed`; samples per affected scene at global frames `start`, `start+⌊dur/2⌋`, `start+dur−1`, plus adjacent-boundary samples `start−1` / `start+dur` when inside the project (clamped like render-manager); `AUDIO_*` retests run `finalizeMedia` on the segment with cues intersecting the scene range re-based to segment start, then `analyzeRenderedMedia` on the mixed segment. `retestRequired` defects not covered by the scope force full mode. Fail → `cycles += 1`, loop to step 5. Pass → step 11.
11. **Master refresh + record** — full proven-path render of the patched IR → `productionReady` required → `persistQaRecord` writes patch + retest record into `project.qa.repairHistory` → `recordArtifact` + `saveRunState`. Transition `repair→rendering→qa` → delivery proceeds through existing commands/approvals. Exit 0.
12. **Escalate** — at the cycle limit or when no applicable patch exists: `transitionRun(run,"failed")`, write `escalations/escalation-<runId>-a<n>.json` (+ `.md`), exit code 3.

Escalation report shape:

```json
{
  "schemaVersion": "1.0.0", "type": "repair-escalation",
  "projectId": "…", "runId": "…", "attempt": 2, "maxCycles": 2,
  "unresolvedDefects": [ { "defectId": "…", "code": "ASSET_REFERENCE_MISSING",
    "severity": "high", "sceneId": "scene-01", "timeRangeFrames": null,
    "evidence": {"type": "frame", "path": "…"}, "repairOwner": "asset-producer",
    "reasonNotRepaired": "No same-kind verified asset candidate exists for rebind_asset." } ],
  "repairHistory": ["…"], "requestedAction": "human-review", "createdAt": "…"
}
```

### 4.3 Key signatures

```js
// packages/core/src/patch.mjs (pure, no fs)
classifyDefects(defects, {project, routePlan}) -> {autoRepairable, conditional, reportableOnly}
createPatchFromDefects(project, classification, {attempt, maxCycles, runId}) -> patchEnvelope | null
validateRepairPatch(patch, project) -> {valid, issues}
applyRepairPatch(project, patch) -> {project, patchedIrSha256, appliedOps}   // throws PatchError

// packages/orchestrator/src/quality-gates.mjs
loadQualityGates(configPath) -> {version, repair:{maxCycles 1..3, targetedRerender, retestRequired}, sourcePath, sha256}

// packages/orchestrator/src/run-state.mjs
loadRunState(projectRoot) -> state | null
saveRunState(projectRoot, state) -> path
invalidateOnInputChange(state, {projectIrSha256, projectFileSha256}) -> {state, invalidated}
computeRepairCyclesFromLedger(project, runId) -> int

// packages/repair-executor/src/index.mjs
decideRerenderScope({project, patchedProject, defects, gates, routePlan}) -> {mode, sceneIds, reason}
executeRepairCycle({projectFile, project, run, gates, qaResult, options}) -> {outcome, attempt, patch, retestScope, artifacts}
runRepairLoop({projectFile, configPath, maxCyclesOverride, quality, dryRun}) -> {status, run, project, escalations, renderManifests}
writeEscalationReport(projectRoot, {run, defects, history, attempt, maxCycles}) -> {jsonPath, markdownPath}

// packages/render-manager/src/index.mjs (additive)
renderHyperFramesProject(project, options /* + sceneIds, renderLabel, throwOnQaFailure=true */)
// manifest gains sceneTimeline
```

## 5. Run persistence + policy unification

`projects/<id>/run-state.json`:

```json
{
  "schemaVersion": "1.0.0",
  "projectId": "…", "runId": "…", "status": "qa",
  "policy": { "maxCycles": 2, "targetedRerender": true, "retestRequired": true, "workers": 1, "qualityGatesSha256": "…" },
  "inputHashes": { "projectIrSha256": "…", "projectFileSha256": "…" },
  "artifacts": [ { "id": "…", "kind": "master-render", "path": "…", "sha256": "…", "verified": true, "recordedAt": "…" } ],
  "repair": { "cycles": 1, "maxCycles": 2, "history": ["…"] },
  "approvals": [],
  "events": [ { "revision": 3, "from": "rendering", "to": "qa", "at": "…", "metadata": {} } ],
  "updatedAt": "…"
}
```

- Resume-from-verified-artifact: reusable only when `verified:true`, recorded `projectIrSha256` equals the current input hash, and the on-disk file hash matches. Anything else re-renders.
- Invalidation resets status to `planned`, drops unverified artifacts, keeps the append-only ledger/events.
- Concurrency 1 structural (executor `workers:1`; orchestrator graph `maxWorkers:1`).
- Policy sentence for the roadmap: "Default and ceiling for automatic repair cycles is 2 (configs/quality-gates.json); the implementation hard-caps at 3; raising the production policy beyond 2 requires a documented config and docs change."

## 6. File-change list

**New:** `packages/core/src/patch.mjs` (+test), `packages/orchestrator/src/quality-gates.mjs` (+test), `packages/orchestrator/src/run-state.mjs` (+test), `packages/repair-executor/{package.json, src/index.mjs, src/retest-scope.mjs, src/escalation.mjs}` (+tests + fixtures).

**Modified:** `packages/core/src/index.mjs` (exports), `packages/core/src/render-qa.mjs` (sceneTimeline attribution), `packages/core/src/qa-record.mjs` (patch/retestScope passthrough), `packages/render-manager/src/index.mjs` (sceneTimeline, scoped render, throwOnQaFailure, renderLabel, placeholders off in repair mode), `apps/cli/src/index.mjs` (`repair` command; `render` gates-derived maxRepairAttempts), roadmap 1.7 checkboxes + retry-policy sentence.

**Not changed:** `packages/ffmpeg` (no concat v1), `packages/delivery-manager` (IR-hash binding already rejects a master not rendered from the patched IR), `packages/hyperframes-adapter`, orchestrator state machine, `visual-critic.mjs`, `AGENTS.md`.

## 7. Safety envelope

1. IR-only writes (whitelists; `applyRepairPatch` returns a clone; executor writes only project.json, history/, run-state.json, escalations/, renders/repair/).
2. No shell — all execution stays in existing fixed-executable/argv-array spawn paths; new CLI args are constant strings from sanitized ids.
3. Validate-before-render with no-new-issues guarantee.
4. Escalation cannot be bypassed — three independent locks (`createRepairPlan` escalate status; `transitionRun` throw at limit; IR-ledger recount). Unresolved critical/high defects cannot reach `delivered`.
5. Visual critic stays advisory (`advisoryOnly:true`, `canOverrideDeterministicGates:false`); never consumed as patch input.
6. Placeholders cannot masquerade as repairs (`allowMissingAssetsAsPlaceholders:false` in repair renders).

## 8. Test strategy

- Unit: patch ops validate/apply on fixture IRs; unknown op/field/target → issues; stale CAS rejected; enum/domain enforcement; no-new-issues rule; clone purity; per-code classification (§3.3), especially `ASSET_REFERENCE_MISSING` with/without candidate; gates loader defaults/rejection/round-trip; run-state save/load/invalidation/ledger recount; retest-scope sample formula + clamping; escalation report shape + exit contract; scene-scoped compile equality regression guard.
- Integration (real HyperFrames, skip when CLI/browser unavailable): injected-defect exit-gate scenario — 2-scene fixture with FONT_UNSPECIFIED, TEXT_TOO_SMALL, safe-area violation, TEXT_OVERFLOW_ESTIMATED, ASSET_REFERENCE_MISSING, static-hold scene; assert detection + localization, validated patch, targeted renders, retests pass, full master productionReady, ledger contains patch with both hashes; escalation variant with no candidate asset escalates after 2 cycles (exit 3, no third-cycle render).
- Segment/full consistency probe: render a scene standalone via `--composition`, compare per-frame perceptual signature against the same range of the full master (stricter threshold).
- Manual/runtime evidence: one full `repair` run recorded as roadmap evidence.

## 9. Migration path

1. Land `core/patch.mjs` + classification + tests (no behavior change). ✅ 2026-11-11
2. Land `orchestrator/quality-gates.mjs` + `run-state.mjs`; wire gates into the `render` CLI flag. ✅ 2026-11-11
3. Extend `render-manager` (sceneTimeline, scoped render, throwOnQaFailure). ✅ 2026-11-11
4. Land `repair-executor` + `repair` CLI command; extend `qa-record` fields. ✅ 2026-11-12
5. Delete `packages/core/schemas/project.schema.json` (dead) or mark non-normative. ✅ 2026-11-12 (deleted — referenced by no code)
6. Update roadmap 1.7 checkboxes + retry-policy sentence. ✅ 2026-11-12

**Deferred findings** (known P2s from the 2026-11-12 repair-execution review, to address in a follow-up): a repair cycle's full render overwrites the master render's `<output>.render.json` sidecar manifest, and a targeted render's `manifest.output` is a segments directory rather than a single file; media-analysis defect ids (`media-001`…) are position-dependent, so the same finding can change identity between cycles and break defect-id tracking across ledger entries.

**Open questions:** (1) RESOLVED positively 2026-11-12: whether `render --composition scenes/<id>.html` produces frames consistent with the same range of the root render. The segment/full consistency probe (real renders, 2 scenes × 2 s) measured per-frame mean-absolute-difference max 0.075 / mean 0.058 against thresholds ≤1.25 / ≤0.5 — targeted scene renders are frame-consistent with the full master. The whole-project fallback is retained for policy, missing-scene-attribution and runtime-failure cases. (2) OPEN: whether HyperFrames `check` samples seeks across all scene files or only the root — observable in the probe run. (3) OPEN: operator consent for autonomous `project.json` overwrite: history/ backups exist; whether `--apply` confirmation is required by default is a product decision (v1: explicit `repair` command invocation IS the consent; `--dry-run` available).

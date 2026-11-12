import test from "node:test";
import assert from "node:assert/strict";
import {
  PatchError, projectIrSha256, MOTION_PRESETS, MOTION_EASINGS, OP_TYPES,
  DEFECT_REPAIR_REGISTRY, registryEntryFor, classifyDefects,
  createPatchFromDefects, validateRepairPatch, applyRepairPatch, computeRunGainBudgetUsed
} from "./patch.mjs";
import { validateProject as validateIr } from "./validate-project.mjs";

function projectFixture(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    project: { id: "patch-fixture", name: "Patch Fixture", objective: "Verify repair patches.", frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080 }, totalDurationFrames: 120 },
    creative: { concept: "Invisible energy use becomes visible.", audience: "Homeowners.", message: "See where your power goes." },
    brand: { fonts: { display: "Arial", body: "Arial" } },
    assets: [
      { id: "img-a", kind: "image", uri: "assets/img-a.png" },
      { id: "img-b", kind: "image", uri: "assets/img-b.png" },
      { id: "snd", kind: "audio", uri: "assets/snd.wav" }
    ],
    scenes: [
      {
        id: "scene-1", name: "Hook", intent: "Stop the scroll.", durationFrames: 60,
        layers: [
          { id: "t1", kind: "text", content: { text: "Hello" }, typography: { family: "Arial", sizePx: 96, lineHeight: 1.1 }, transform: { x: 200, y: 200, width: 600, height: 130 }, motion: { preset: "fade", durationFrames: 20 } },
          { id: "img1", kind: "image", assetId: "missing-img", transform: { x: 900, y: 200, width: 400, height: 300 } }
        ],
        audioCues: [{ assetId: "snd", offsetFrames: 0, durationFrames: 30 }]
      },
      {
        id: "scene-2", name: "Proof", startFrame: 60, durationFrames: 60, intent: "Show the product.",
        layers: [{ id: "t2", kind: "text", content: { text: "Bye" }, typography: { family: "Arial", sizePx: 12 } }]
      }
    ],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] },
    ...overrides
  };
}

const hex64 = "a".repeat(64);

function opPatch(ops, base = hex64) {
  return { runId: "run-1", attempt: 0, maxCycles: 2, basedOnIrSha256: base, ops, createdAt: "2026-11-11T00:00:00.000Z" };
}

test("fixture project is a valid Canonical Video IR with one known warning", () => {
  const project = projectFixture();
  const result = validateIr(project);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues.map(item => item.code), ["ASSET_REFERENCE_UNRESOLVED"]);
});

test("the registry maps every code to one policy and a known operation", () => {
  for (const [code, entry] of Object.entries(DEFECT_REPAIR_REGISTRY)) {
    if (code === "REPORT") continue;
    assert.ok(["AUTO", "COND", "REPORT"].includes(entry.policy), code + " policy");
    if (entry.policy === "REPORT") assert.equal(entry.op, null, code + " report entry");
    else {
      assert.ok(OP_TYPES.has(entry.op), code + " op type");
      assert.equal(typeof entry.build, "function", code + " builder");
    }
  }
  assert.equal(MOTION_PRESETS.has("float"), true);
  assert.equal(MOTION_EASINGS.has("power2.out"), true);
});

test("registryEntryFor resolves BLOCKING_ prefixed compiler warnings and defaults unknown codes to REPORT", () => {
  assert.equal(registryEntryFor("TEXT_TOO_SMALL").policy, "AUTO");
  assert.equal(registryEntryFor("BLOCKING_TEXT_OVERFLOW_ESTIMATED").policy, "COND");
  assert.equal(registryEntryFor("BLOCKING_ASSET_REFERENCE_MISSING").op, "rebind_asset");
  assert.equal(registryEntryFor("CHECK_FAILED_DIMENSIONSMATCH").policy, "REPORT");
  assert.equal(registryEntryFor("FRAME_DECODE_FAILED_1").policy, "COND");
  assert.equal(registryEntryFor("FRAME_DECODE_FAILED_1").retry, "rerender-once");
  assert.equal(registryEntryFor("TOTALLY_UNKNOWN_CODE").policy, "REPORT");
});

test("classifyDefects builds AUTO typography ops from QA defects", () => {
  const project = projectFixture();
  project.scenes[1].layers[0].typography.safeArea = false;
  const defects = [
    { defectId: "qa-001", code: "TEXT_TOO_SMALL", severity: "medium", sceneId: "scene-2" },
    { defectId: "qa-002", code: "TEXT_SAFE_AREA_DISABLED", severity: "medium", sceneId: "scene-2" }
  ];
  const classification = classifyDefects(defects, { project });
  assert.equal(classification.counts.total, 2);
  assert.equal(classification.counts.AUTO, 2);
  assert.equal(classification.counts.repairable, 2);
  const tooSmall = classification.items.find(item => item.code === "TEXT_TOO_SMALL");
  // 1920x1080 type-scale caption size (design §3.3: max(18, caption size)).
  assert.deepEqual(tooSmall.ops, [{ type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { sizePx: 27 } }]);
  const safeArea = classification.items.find(item => item.code === "TEXT_SAFE_AREA_DISABLED");
  assert.deepEqual(safeArea.ops[0].value, { safeArea: true });
});

test("classifyDefects clamps overrunning layers and cue durations from validator issues", () => {
  const project = projectFixture();
  project.scenes[0].layers[1].durationFrames = 100;
  project.scenes[0].audioCues[0].durationFrames = 500;
  const classification = classifyDefects([
    { code: "LAYER_EXCEEDS_SCENE_DURATION", path: "$.scenes[0].layers[1]", severity: "error", sceneId: "scene-1" },
    { code: "INVALID_AUDIO_DURATION", path: "$.scenes[0].audioCues[0]", severity: "error" }
  ], { project });
  const timing = classification.items.find(item => item.code === "LAYER_EXCEEDS_SCENE_DURATION");
  assert.deepEqual(timing.ops, [{ type: "set_timing", target: { sceneId: "scene-1", layerId: "img1" }, value: { durationFrames: 60 } }]);
  const cue = classification.items.find(item => item.code === "INVALID_AUDIO_DURATION");
  assert.deepEqual(cue.ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { durationFrames: 60 } }]);
});

test("createPatchFromDefects builds a compare-and-swap patch and returns null when nothing is repairable", () => {
  const project = projectFixture();
  const defects = [{ defectId: "qa-001", code: "TEXT_TOO_SMALL", severity: "medium", sceneId: "scene-2" }];
  const patch = createPatchFromDefects(project, classifyDefects(defects, { project }), { attempt: 1, maxCycles: 2, runId: "run-9" });
  assert.equal(patch.basedOnIrSha256, projectIrSha256(project));
  assert.equal(patch.runId, "run-9");
  assert.equal(patch.attempt, 1);
  assert.equal(patch.maxCycles, 2);
  assert.equal(patch.ops[0].reason.code, "TEXT_TOO_SMALL");
  const empty = createPatchFromDefects(project, classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT" }], { project }), { runId: "run-9" });
  assert.equal(empty, null);
  assert.throws(() => createPatchFromDefects(project, classifyDefects(defects, { project }), { runId: "  " }), PatchError);
  assert.throws(() => createPatchFromDefects(project, classifyDefects(defects, { project }), { runId: "r", maxCycles: 9 }), /maxCycles/);
});

test("validateRepairPatch rejects unknown ops, whitelist violations and stale base hashes", () => {
  const project = projectFixture();
  const base = projectIrSha256(project);
  const cases = [
    { patch: opPatch([{ type: "delete_layer", target: { sceneId: "scene-1", layerId: "t1" }, value: { x: true } }], base), code: "PATCH_OP_TYPE_UNKNOWN" },
    { patch: opPatch([{ type: "set_typography", target: { sceneId: "scene-1", layerId: "t1" }, value: { sizePx: 12 } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_typography", target: { sceneId: "scene-1", layerId: "t1" }, value: { safeArea: false } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_typography", target: { sceneId: "scene-1", layerId: "t1" }, value: { family: "Comic Sans" } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_motion", target: { sceneId: "scene-1", layerId: "t1" }, value: { preset: "bounce" } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_motion", target: { sceneId: "scene-1", layerId: "t1" }, value: { easing: "elastic.out" } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_transform", target: { sceneId: "scene-1", layerId: "t1" }, value: { width: -5 } }], base), code: "PATCH_VALUE_INVALID" },
    { patch: opPatch([{ type: "set_typography", target: { sceneId: "scene-1", layerId: "t1" }, value: { color: "#fff" } }], base), code: "PATCH_FIELD_NOT_PERMITTED" },
    { patch: opPatch([{ type: "set_typography", target: { sceneId: "nope", layerId: "t1" }, value: { sizePx: 20 } }], base), code: "PATCH_TARGET_UNRESOLVED" },
    { patch: opPatch([{ type: "set_audio_cue", target: { index: 3 }, value: { volume: 2 } }], base), code: "PATCH_TARGET_UNRESOLVED" },
    { patch: opPatch([{ type: "rebind_asset", target: { sceneId: "scene-1", layerId: "img1" }, value: { assetId: "snd" } }], base), code: "PATCH_ASSET_KIND_MISMATCH" },
    { patch: opPatch([{ type: "set_timing", target: { sceneId: "scene-1" }, value: { durationFrames: 10 } }], "b".repeat(64)), code: "PATCH_BASE_MISMATCH" },
    { patch: opPatch([], base), code: "PATCH_OPS_REQUIRED" }
  ];
  for (const { patch, code } of cases) {
    const result = validateRepairPatch(patch, project);
    assert.equal(result.valid, false, code);
    assert.ok(result.issues.some(item => item.code === code), code);
    assert.deepEqual(Object.keys(result.issues[0]), ["code", "path", "message", "severity"]);
  }
});

test("applyRepairPatch applies ops sequentially, re-resolving targets against the patched clone", () => {
  const project = projectFixture();
  const base = projectIrSha256(project);
  const patch = opPatch([
    { type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { sizePx: 18 } },
    { type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { weight: 800 } },
    { type: "set_motion", target: { sceneId: "scene-2", layerId: "t2" }, value: { preset: "float", easing: "power2.out", durationFrames: 30, delayFrames: 0 } },
    { type: "rebind_asset", target: { sceneId: "scene-1", layerId: "img1" }, value: { assetId: "img-b" } }
  ], base);
  const result = applyRepairPatch(project, patch);
  assert.equal(validateIr(result.project).valid, true);
  assert.ok(result.project !== project);
  assert.deepEqual(result.project.scenes[0].layers[1].assetId, "img-b");
  assert.equal(project.scenes[0].layers[1].assetId, "missing-img");
  assert.deepEqual(result.project.scenes[1].layers[0].typography, { family: "Arial", sizePx: 18, weight: 800 });
  assert.deepEqual(result.project.scenes[1].layers[0].motion, { preset: "float", easing: "power2.out", durationFrames: 30, delayFrames: 0 });
  assert.equal(result.patchedIrSha256, projectIrSha256(result.project));
  assert.notEqual(result.patchedIrSha256, base);
  assert.equal(result.appliedOps.length, 4);
  assert.deepEqual(result.appliedOps[0], { type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { sizePx: 18 } });
});

test("applyRepairPatch rejects stale base revisions with a compare-and-swap error", () => {
  const project = projectFixture();
  const patch = opPatch([{ type: "set_timing", target: { sceneId: "scene-1" }, value: { startFrame: 0 } }], "c".repeat(64));
  try {
    applyRepairPatch(project, patch);
    assert.fail("expected PatchError");
  } catch (error) {
    assert.ok(error instanceof PatchError);
    assert.equal(error.code, "PATCH_BASE_MISMATCH");
    assert.equal(error.details.currentIrSha256, projectIrSha256(project));
  }
});

test("applyRepairPatch rejects patches that would introduce new validation codes", () => {
  const project = projectFixture();
  const patch = opPatch([{ type: "set_timing", target: { sceneId: "scene-1", layerId: "t1" }, value: { durationFrames: 200 } }], projectIrSha256(project));
  try {
    applyRepairPatch(project, patch);
    assert.fail("expected PatchError");
  } catch (error) {
    assert.ok(error instanceof PatchError);
    assert.equal(error.code, "PATCH_VALIDATION_FAILED");
    assert.deepEqual(error.details.newCodes, ["LAYER_EXCEEDS_SCENE_DURATION"]);
  }
});

test("applyRepairPatch repairs validator errors so the patched IR becomes valid", () => {
  const project = projectFixture();
  project.scenes[0].audioCues[0].durationFrames = 500;
  assert.equal(validateIr(project).valid, false);
  const classification = classifyDefects([{ code: "INVALID_AUDIO_DURATION", severity: "error" }], { project });
  const patch = createPatchFromDefects(project, classification, { runId: "run-2" });
  const result = applyRepairPatch(project, patch);
  assert.equal(validateIr(result.project).valid, true);
  assert.equal(result.project.scenes[0].audioCues[0].durationFrames, 60);
});

test("classifyDefects keeps unmet COND conditions unrepairable and unknown codes REPORTed", () => {
  const project = projectFixture();
  project.assets = [];
  const classification = classifyDefects([
    { defectId: "qa-001", code: "ASSET_REFERENCE_MISSING", severity: "high", sceneId: "scene-1" },
    { defectId: "qa-002", code: "AUDIO_SILENCE_SEGMENT", severity: "high", sceneId: "project" },
    { defectId: "qa-003", code: "TOTALLY_UNKNOWN_CODE", severity: "low" }
  ], { project });
  const rebind = classification.items.find(item => item.code === "ASSET_REFERENCE_MISSING");
  assert.equal(rebind.policy, "COND");
  assert.deepEqual(rebind.ops, []);
  assert.match(rebind.reason, /Condition not met/);
  // Reconciled (design §3.3): silence is COND — here unmet because the defect
  // carries no attributable frame range.
  const silence = classification.items.find(item => item.code === "AUDIO_SILENCE_SEGMENT");
  assert.equal(silence.policy, "COND");
  assert.deepEqual(silence.ops, []);
  const unknown = classification.items.find(item => item.code === "TOTALLY_UNKNOWN_CODE");
  assert.equal(unknown.policy, "REPORT");
  assert.deepEqual(unknown.ops, []);
});

test("TEXT_TOO_SMALL pairs the caption-size raise with a safe-area box enlargement and escalates when neither fits", () => {
  const project = projectFixture();
  const longText = "A legacy of growth that keeps compounding through every single season of the year";
  project.scenes[1].layers[0] = {
    id: "t2", kind: "text", content: { text: longText },
    typography: { family: "Arial", sizePx: 12, lineHeight: 1.08 },
    transform: { x: 140, y: 900, width: 800, height: 40 }
  };
  const paired = classifyDefects([{ code: "TEXT_TOO_SMALL", sceneId: "scene-2" }], { project });
  const pairedOps = paired.items[0].ops;
  assert.equal(pairedOps.length, 2);
  assert.deepEqual(pairedOps[0].value, { sizePx: 27 });
  assert.equal(pairedOps[1].type, "set_transform");
  assert.equal(pairedOps[1].value.height, 59);
  // No room left inside the safe area: the enlargement cannot fit, so the
  // defect is REPORTed instead of patched.
  project.scenes[1].layers[0].transform = { x: 140, y: 1020, width: 800, height: 20 };
  const escalated = classifyDefects([{ code: "TEXT_TOO_SMALL", sceneId: "scene-2" }], { project });
  assert.deepEqual(escalated.items[0].ops, []);
  assert.match(escalated.items[0].reason, /neither fits|escalates/);
});

test("TEXT_SAFE_AREA_DISABLED re-enables the safe area and clamps boxes that violate it", () => {
  const project = projectFixture();
  project.scenes[1].layers[0].typography.safeArea = false;
  project.scenes[1].layers[0].transform = { x: 10, y: 10, width: 800, height: 180 };
  const classification = classifyDefects([{ code: "TEXT_SAFE_AREA_DISABLED", sceneId: "scene-2" }], { project });
  assert.deepEqual(classification.items[0].ops, [
    { type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { safeArea: true } },
    { type: "set_transform", target: { sceneId: "scene-2", layerId: "t2" }, value: { x: 96, y: 54 } }
  ]);
});

test("TEXT_OVERFLOW_ESTIMATED enlarges the box first, then shrinks, then reports", () => {
  const project = projectFixture();
  const longText = "This supporting line runs far past the width of its box and needs several lines to fit";
  project.scenes[1].layers[0] = {
    id: "t2", kind: "text", content: { text: longText },
    typography: { family: "Arial", sizePx: 42, lineHeight: 1.08 },
    transform: { x: 140, y: 560, width: 400, height: 80 }
  };
  const enlarge = classifyDefects([{ code: "TEXT_OVERFLOW_ESTIMATED", sceneId: "scene-2" }], { project });
  assert.deepEqual(enlarge.items[0].ops, [{ type: "set_transform", target: { sceneId: "scene-2", layerId: "t2" }, value: { height: 273 } }]);
  // No safe-area headroom above the box: fall back to shrinking the font size.
  project.scenes[1].layers[0].transform = { x: 140, y: 960, width: 800, height: 80 };
  project.scenes[1].layers[0].content = { text: "A two line supporting statement that overflows its tight box" };
  const shrink = classifyDefects([{ code: "TEXT_OVERFLOW_ESTIMATED", sceneId: "scene-2" }], { project });
  assert.deepEqual(shrink.items[0].ops, [{ type: "set_typography", target: { sceneId: "scene-2", layerId: "t2" }, value: { sizePx: 36 } }]);
  // Shrinking below the 18 px floor is impossible: REPORT (no ops).
  project.scenes[1].layers[0].transform = { x: 140, y: 960, width: 200, height: 40 };
  const report = classifyDefects([{ code: "TEXT_OVERFLOW_ESTIMATED", sceneId: "scene-2" }], { project });
  assert.deepEqual(report.items[0].ops, []);
});

test("OCR_TEXT_OUTSIDE_SAFE_AREA clamps only when exactly one text layer matches", () => {
  const project = projectFixture();
  project.scenes[1].layers[0].transform = { x: 10, y: 10, width: 800, height: 180 };
  const single = classifyDefects([{ code: "OCR_TEXT_OUTSIDE_SAFE_AREA", sceneId: "scene-2" }], { project });
  assert.deepEqual(single.items[0].ops, [{ type: "set_transform", target: { sceneId: "scene-2", layerId: "t2" }, value: { x: 96, y: 54 } }]);
  project.scenes[1].layers.push({ id: "t3", kind: "text", content: { text: "Second" }, typography: { family: "Arial", sizePx: 40 }, transform: { x: 5, y: 5, width: 400, height: 90 } });
  const ambiguous = classifyDefects([{ code: "OCR_TEXT_OUTSIDE_SAFE_AREA", sceneId: "scene-2" }], { project });
  assert.deepEqual(ambiguous.items[0].ops, []);
  assert.match(ambiguous.items[0].reason, /exactly one|ambiguous|reported/);
});

test("ASSET_REFERENCE_MISSING rebinds to a verified same-kind candidate and refuses hashed-but-unverified assets", () => {
  const project = projectFixture();
  project.assets = [
    { id: "img-hashed", kind: "image", uri: "assets/img-hashed.png", sha256: "c".repeat(64) },
    { id: "img-b", kind: "image", uri: "assets/img-b.png", sha256: "b".repeat(64) },
    { id: "img-a", kind: "image", uri: "assets/img-a.png" }
  ];
  const verified = classifyDefects([{ code: "ASSET_REFERENCE_MISSING", sceneId: "scene-1" }], { project, verifiedAssetIds: new Set(["img-b"]) });
  assert.deepEqual(verified.items[0].ops, [{ type: "rebind_asset", target: { sceneId: "scene-1", layerId: "img1" }, value: { assetId: "img-b" } }]);
  // Hashed candidates without on-disk verification are refused; the unhashed asset stays eligible.
  const unverified = classifyDefects([{ code: "ASSET_REFERENCE_MISSING", sceneId: "scene-1" }], { project });
  assert.deepEqual(unverified.items[0].ops.map(op => op.value.assetId), ["img-a"]);
  project.assets = [{ id: "img-hashed", kind: "image", uri: "assets/img-hashed.png", sha256: "c".repeat(64) }];
  const refused = classifyDefects([{ code: "ASSET_REFERENCE_MISSING", sceneId: "scene-1" }], { project });
  assert.deepEqual(refused.items[0].ops, []);
});

test("ASSET_FILE_MISSING rebinds layers pointing at the asset with the missing file", () => {
  const project = projectFixture();
  project.scenes[0].layers[1].assetId = "img-a";
  const classification = classifyDefects([{ code: "ASSET_FILE_MISSING", assetId: "img-a", sceneId: "scene-1" }], { project });
  assert.deepEqual(classification.items[0].ops, [{ type: "rebind_asset", target: { sceneId: "scene-1", layerId: "img1" }, value: { assetId: "img-b" } }]);
  const unattributed = classifyDefects([{ code: "ASSET_FILE_MISSING", sceneId: "scene-1" }], { project });
  assert.deepEqual(unattributed.items[0].ops, []);
});

test("CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT canonicalizes the project duration to the scene sum", () => {
  const project = projectFixture();
  project.project.totalDurationFrames = 200;
  assert.equal(validateIr(project).valid, true);
  const classification = classifyDefects([{ code: "CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT", severity: "high" }], { project });
  assert.equal(classification.items[0].policy, "AUTO");
  assert.deepEqual(classification.items[0].ops, [{ type: "set_timing", target: { scope: "project" }, value: { totalDurationFrames: 120 } }]);
  const patch = createPatchFromDefects(project, classification, { runId: "run-1" });
  const result = applyRepairPatch(project, patch);
  assert.equal(result.project.project.totalDurationFrames, 120);
  assert.equal(validateIr(result.project).valid, true);
  // A project-scope duration that disagrees with the scene sum is rejected.
  const stale = validateRepairPatch({ ...patch, ops: [{ type: "set_timing", target: { scope: "project" }, value: { totalDurationFrames: 130 } }] }, project);
  assert.equal(stale.valid, false);
  assert.ok(stale.issues.some(item => item.code === "PATCH_VALUE_INVALID"));
  // Already-consistent durations need no patch op.
  const consistent = classifyDefects([{ code: "CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT", severity: "high" }], { project: projectFixture() });
  assert.deepEqual(consistent.items[0].ops, []);
});

test("FRAME_DECODE_FAILED_n classifies as a conditional re-render retry without patch ops", () => {
  const project = projectFixture();
  const classification = classifyDefects([{ code: "FRAME_DECODE_FAILED_3", severity: "high", sceneId: "scene-1", timeRangeFrames: { startFrame: 30, endFrame: 31 } }], { project });
  const item = classification.items[0];
  assert.equal(item.policy, "COND");
  assert.deepEqual(item.ops, []);
  assert.match(item.reason, /one transient re-render retry/);
});

test("BLOCKING_BLACK_FRAME_SEGMENT covers interior gaps from layer timings and reports clip-edge ranges", () => {
  const project = projectFixture();
  project.scenes[1].layers = [{ id: "gap-bg", kind: "shape", transform: { x: 0, y: 0, width: 1920, height: 1080 }, startFrame: 0, durationFrames: 10 }];
  // scene-2 starts at frame 60; the scene-local gap [10, 60) maps to [70, 120).
  const interior = classifyDefects([{ code: "BLOCKING_BLACK_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 72, endFrame: 76 } }], { project });
  assert.deepEqual(interior.items[0].ops, [{ type: "set_timing", target: { sceneId: "scene-2", layerId: "gap-bg" }, value: { durationFrames: 16 } }]);
  // A later layer shifted over the gap instead of extended.
  project.scenes[1].layers = [{ id: "late", kind: "shape", transform: { x: 0, y: 0, width: 1920, height: 1080 }, startFrame: 20, durationFrames: 40 }];
  const shifted = classifyDefects([{ code: "BLACK_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 72, endFrame: 76 } }], { project });
  assert.deepEqual(shifted.items[0].ops, [{ type: "set_timing", target: { sceneId: "scene-2", layerId: "late" }, value: { startFrame: 12 } }]);
  // Clip-edge ranges may be intentional fades: REPORT (no ops).
  const edgeStart = classifyDefects([{ code: "BLACK_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 0, endFrame: 4 } }], { project });
  assert.deepEqual(edgeStart.items[0].ops, []);
  const edgeEnd = classifyDefects([{ code: "BLACK_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 116, endFrame: 120 } }], { project });
  assert.deepEqual(edgeEnd.items[0].ops, []);
  // Fully covered ranges are not attributable to layer timings.
  project.scenes[1].layers = [{ id: "full", kind: "shape", transform: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const covered = classifyDefects([{ code: "BLACK_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 72, endFrame: 76 } }], { project });
  assert.deepEqual(covered.items[0].ops, []);
});

test("FROZEN_FRAME_SEGMENT and PERCEPTUAL_DUPLICATE_FRAMES float the owning static content layer", () => {
  const project = projectFixture();
  const defects = [
    { code: "FROZEN_FRAME_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 60, endFrame: 120 } },
    { code: "PERCEPTUAL_DUPLICATE_FRAMES", sceneId: "scene-1", timeRangeFrames: { startFrame: 0, endFrame: 60 } }
  ];
  const classification = classifyDefects(defects, { project });
  for (const item of classification.items) {
    assert.equal(item.policy, "COND");
    // scene-1's text layer already moves, so its static image layer owns the hold.
    assert.deepEqual(item.ops, [{ type: "set_motion", target: { sceneId: item.sceneId, layerId: item.sceneId === "scene-1" ? "img1" : "t2" }, value: { preset: "float", durationFrames: 60, delayFrames: 0, easing: "sine.out" } }]);
  }
  // Ambiguous ownership (two static content layers) stays REPORTed.
  project.scenes[1].layers.push({ id: "t3", kind: "chart", content: { chartType: "bar", data: [] }, transform: { x: 0, y: 0, width: 400, height: 300 } });
  const ambiguous = classifyDefects([{ code: "FROZEN_FRAME_SEGMENT", sceneId: "scene-2" }], { project });
  assert.deepEqual(ambiguous.items[0].ops, []);
  // Layers that already move are not static candidates.
  project.scenes[1].layers = [{ id: "moved", kind: "text", content: { text: "Bye" }, typography: { family: "Arial", sizePx: 27 }, motion: { preset: "fade", durationFrames: 20 } }];
  const moving = classifyDefects([{ code: "FROZEN_FRAME_SEGMENT", sceneId: "scene-2" }], { project });
  assert.deepEqual(moving.items[0].ops, []);
});

test("AUDIO_SILENCE_SEGMENT extends or shifts the adjacent narration cue into the gap", () => {
  const project = projectFixture();
  project.scenes[0].audioCues = [{ assetId: "snd", kind: "narration", offsetFrames: 0, durationFrames: 30 }];
  const extend = classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT", sceneId: "scene-1", timeRangeFrames: { startFrame: 30, endFrame: 45 } }], { project });
  assert.deepEqual(extend.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { durationFrames: 45 } }]);
  project.scenes[0].audioCues = [{ assetId: "snd", kind: "narration", offsetFrames: 50, durationFrames: 10 }];
  const shift = classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT", sceneId: "scene-1", timeRangeFrames: { startFrame: 30, endFrame: 45 } }], { project });
  assert.deepEqual(shift.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { offsetFrames: 30, durationFrames: 30 } }]);
  // Unattributable gaps (no narration cue within the adjacency window) stay REPORTed.
  project.scenes[0].audioCues = [{ assetId: "snd", kind: "narration", offsetFrames: 0, durationFrames: 5 }];
  const unattributable = classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT", sceneId: "scene-1", timeRangeFrames: { startFrame: 40, endFrame: 55 } }], { project });
  assert.deepEqual(unattributable.items[0].ops, []);
  // Music cues are never extended into narration gaps.
  project.scenes[0].audioCues = [{ assetId: "snd", kind: "music", offsetFrames: 0, durationFrames: 30 }];
  const music = classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT", sceneId: "scene-1", timeRangeFrames: { startFrame: 30, endFrame: 45 } }], { project });
  assert.deepEqual(music.items[0].ops, []);
});

test("audio cue repairs compare scene cues on the absolute timeline: defects over scene-02 repair its cue, never scene-01's", () => {
  // Scene audioCues.offsetFrames is scene-LOCAL (docs/VIDEO-IR.md) while media
  // defect timeRangeFrames is project-timeline; scene-02 starts at frame 600.
  const project = projectFixture();
  project.project.totalDurationFrames = 720;
  project.scenes = [
    {
      id: "scene-1", name: "Hook", intent: "Stop the scroll.", durationFrames: 600,
      layers: [{ id: "t1", kind: "text", content: { text: "Hello" }, typography: { family: "Arial", sizePx: 96, lineHeight: 1.1 }, transform: { x: 200, y: 200, width: 600, height: 130 } }],
      audioCues: [{ assetId: "snd", kind: "narration", offsetFrames: 0, durationFrames: 60 }]
    },
    {
      id: "scene-2", name: "Proof", startFrame: 600, durationFrames: 120, intent: "Show the product.",
      layers: [{ id: "t2", kind: "text", content: { text: "Bye" }, typography: { family: "Arial", sizePx: 96, lineHeight: 1.1 }, transform: { x: 200, y: 200, width: 600, height: 130 } }],
      audioCues: [{ assetId: "snd", kind: "narration", offsetFrames: 0, durationFrames: 60 }]
    }
  ];
  // (a) A too-quiet defect over scene-02's range produces the op targeting
  // scene-02's cue — zero ops before the absolute-base fix.
  const scene2Defect = { code: "AUDIO_PROGRAM_TOO_QUIET", sceneId: "scene-2", timeRangeFrames: { startFrame: 600, endFrame: 660 }, value: -27, threshold: -24 };
  const scene2 = classifyDefects([scene2Defect], { project });
  assert.deepEqual(scene2.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-2", index: 0 }, value: { volume: 1.41 }, gainDb: 3 }]);
  // (b) The same kind of defect over scene-01's range does NOT touch scene-02's cue.
  const scene1 = classifyDefects([{ ...scene2Defect, sceneId: "scene-1", timeRangeFrames: { startFrame: 0, endFrame: 60 } }], { project });
  assert.deepEqual(scene1.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 1.41 }, gainDb: 3 }]);
  // Silence-gap closure: a gap at project frames [600, 615) shifts scene-02's
  // following cue with a scene-LOCAL offset (600 - base 600 = 0), not 600.
  project.scenes[1].audioCues = [{ assetId: "snd", kind: "narration", offsetFrames: 30, durationFrames: 30 }];
  const gap = classifyDefects([{ code: "AUDIO_SILENCE_SEGMENT", sceneId: "scene-2", timeRangeFrames: { startFrame: 600, endFrame: 615 } }], { project });
  assert.deepEqual(gap.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-2", index: 0 }, value: { offsetFrames: 0, durationFrames: 60 } }]);
});

test("audio gain ops share the ±6 dB budget across defects within one classification", () => {
  const project = projectFixture();
  project.scenes[1].audioCues = [{ assetId: "snd", kind: "narration", offsetFrames: 0, durationFrames: 30 }];
  const quiet = (sceneId, startFrame) => ({ code: "AUDIO_PROGRAM_TOO_QUIET", sceneId, timeRangeFrames: { startFrame, endFrame: startFrame + 30 }, value: -26, threshold: -24 });
  // (a) Two distinct cues, 2 dB each: both repaired, 4 dB total (within budget).
  const within = classifyDefects([quiet("scene-1", 0), quiet("scene-2", 60)], { project, runId: "run-1" });
  assert.deepEqual(within.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 1.26 }, gainDb: 2 }]);
  assert.deepEqual(within.items[1].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-2", index: 0 }, value: { volume: 1.26 }, gainDb: 2 }]);
  assert.equal(within.items.flatMap(item => item.ops).reduce((sum, op) => sum + Math.abs(op.gainDb), 0), 4);
  // (b) Two distinct cues needing 12 dB each: the budget caps the total at
  // exactly 6 dB and the unfunded defect is not gain-patched.
  const loud = (sceneId, startFrame) => ({ code: "AUDIO_PROGRAM_TOO_QUIET", sceneId, timeRangeFrames: { startFrame, endFrame: startFrame + 30 }, value: -36, threshold: -24 });
  const over = classifyDefects([loud("scene-1", 0), loud("scene-2", 60)], { project, runId: "run-1" });
  assert.deepEqual(over.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 2 }, gainDb: 6 }]);
  assert.deepEqual(over.items[1].ops, []);
  assert.match(over.items[1].reason, /Condition not met/);
  assert.equal(over.items.flatMap(item => item.ops).reduce((sum, op) => sum + Math.abs(op.gainDb), 0), 6);
});

test("two gain defects on the same cue merge into one op whose gainDb equals the applied net gain", () => {
  const project = projectFixture();
  const defect = start => ({ code: "AUDIO_PROGRAM_TOO_QUIET", sceneId: "scene-1", timeRangeFrames: { startFrame: start, endFrame: start + 30 }, value: -27, threshold: -24 });
  const classification = classifyDefects([defect(0), defect(10)], { project, runId: "run-1" });
  // The first item carries the merged op; the second contributed without a
  // second op on the same cue (applyOp merges by assignment, so two ops would
  // lose the first gain while the ledger still counted it).
  assert.deepEqual(classification.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 2 }, gainDb: 6 }]);
  assert.deepEqual(classification.items[1].ops, []);
  assert.equal(classification.items.flatMap(item => item.ops).reduce((sum, op) => sum + Math.abs(op.gainDb), 0), 6);
  const patch = createPatchFromDefects(project, classification, { runId: "run-1" });
  assert.equal(patch.ops.length, 1);
  const applied = applyRepairPatch(project, patch);
  assert.equal(applied.project.scenes[0].audioCues[0].volume, 2);
  // Ledger recount of the applied patch equals the applied net gain (6 dB).
  const ledger = { qa: { repairHistory: [{ runId: "run-1", status: "repair-required", patch }] } };
  assert.equal(computeRunGainBudgetUsed(ledger, "run-1"), 6);
  assert.equal(Math.round(Math.log10(applied.project.scenes[0].audioCues[0].volume) * 20 * 100) / 100, 6.02);
});

test("audio volume repairs apply reduction-only for loud and true-peak defects", () => {
  const project = projectFixture();
  const loud = classifyDefects([{ code: "AUDIO_PROGRAM_TOO_LOUD", sceneId: "scene-1", timeRangeFrames: { startFrame: 0, endFrame: 30 }, value: -10, threshold: -12 }], { project });
  assert.deepEqual(loud.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 0.79 }, gainDb: -2 }]);
  const peak = classifyDefects([{ code: "AUDIO_TRUE_PEAK_EXCEEDED", sceneId: "scene-1", timeRangeFrames: { startFrame: 0, endFrame: 30 }, value: 0, threshold: -1 }], { project });
  assert.deepEqual(peak.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 0.89 }, gainDb: -1 }]);
});

test("audio gain repairs respect the cumulative ±6 dB budget recounted from the run ledger", () => {
  const project = projectFixture();
  const defect = { code: "AUDIO_PROGRAM_TOO_QUIET", sceneId: "scene-1", timeRangeFrames: { startFrame: 0, endFrame: 30 }, value: -30, threshold: -24 };
  // No prior cycles: the full 6 dB budget is available.
  const first = classifyDefects([defect], { project, runId: "run-1" });
  assert.deepEqual(first.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 2 }, gainDb: 6 }]);
  // A prior cycle spent 4 dB: only 2 dB remain.
  project.qa = { repairHistory: [{ runId: "run-1", status: "repair-required", patch: { ops: [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 1.58 }, gainDb: 4 }] } }] };
  const second = classifyDefects([defect], { project, runId: "run-1" });
  assert.deepEqual(second.items[0].ops, [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 1.26 }, gainDb: 2 }]);
  // Budget exhausted (4 + 3 from another entry of the same run): no ops, condition unmet.
  project.qa.repairHistory.push({ runId: "run-1", status: "repair-required", patch: { ops: [{ type: "set_audio_cue", target: { sceneId: "scene-1", index: 0 }, value: { volume: 1.12 }, gainDb: -3 }] } });
  const exhausted = classifyDefects([defect], { project, runId: "run-1" });
  assert.deepEqual(exhausted.items[0].ops, []);
  assert.match(exhausted.items[0].reason, /Condition not met/);
  // Other runs never consume this run's budget.
  const otherRun = classifyDefects([defect], { project, runId: "run-2" });
  assert.equal(otherRun.items[0].ops.length, 1);
  assert.equal(computeRunGainBudgetUsed(project, "run-1"), 7);
  assert.equal(computeRunGainBudgetUsed(project, "run-2"), 0);
  assert.throws(() => computeRunGainBudgetUsed(project, "  "), /runId/);
});

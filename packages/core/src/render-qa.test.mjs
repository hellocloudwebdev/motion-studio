import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRenderEvidence, createRepairPlan } from "./render-qa.mjs";

const good = {
  verified: true, productionReady: true, output: "/tmp/master.mp4", bytes: 1200,
  checks: { dimensionsMatch: true, frameRateMatch: true, durationWithinOneFrame: true },
  frameEvidence: [{ decoded: true, bytes: 800 }, { decoded: true, bytes: 900 }],
  blockingWarnings: []
};

test("accepts complete verified render evidence", () => {
  const result = evaluateRenderEvidence(good);
  assert.equal(result.passed, true);
  assert.equal(result.productionReady, true);
  assert.equal(result.summary.total, 0);
});

test("fails closed when output checks or sampled frames fail", () => {
  const result = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30000, denominator: 1001 }, checks: { dimensionsMatch: false }, frameEvidence: [{ decoded: false, bytes: 0, atSeconds: 1.001, path: "qa/frame.png", sceneId: "scene-2" }] });
  assert.equal(result.passed, false);
  assert.ok(result.defects.some(item => item.code === "CHECK_FAILED_DIMENSIONSMATCH"));
  assert.ok(result.defects.some(item => item.code === "FRAME_DECODE_FAILED_1"));
  const frameDefect = result.defects.find(item => item.code === "FRAME_DECODE_FAILED_1");
  assert.deepEqual(frameDefect.timeRangeFrames, { startFrame: 30, endFrame: 31 });
  assert.equal(frameDefect.sceneId, "scene-2");
  assert.equal(frameDefect.repairOwner, "render-engine");
  assert.equal(frameDefect.evidence.path, "qa/frame.png");
});

test("creates scene-scoped repair actions and enforces retry ceiling", () => {
  const qa = { defects: [
    { defectId: "a", severity: "high", sceneId: "intro", repairOwner: "typography-specialist", retestRequired: true },
    { defectId: "b", severity: "medium", sceneId: "intro", repairOwner: "typography-specialist", retestRequired: true },
    { defectId: "c", severity: "high", sceneId: "outro", repairOwner: "asset-producer", retestRequired: true }
  ] };
  const plan = createRepairPlan(qa, { attempt: 1, maxAttempts: 2 });
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0].scope, "intro");
  // Only critical/high defects are actionable; the medium one is recorded as
  // reviewed-non-blocking instead of widening the repair instruction.
  assert.deepEqual(plan.actions[0].defectIds, ["a"]);
  assert.deepEqual(plan.nonBlocking.map(item => item.defectId), ["b"]);
  assert.equal(createRepairPlan(qa, { attempt: 2, maxAttempts: 2 }).status, "escalate");
});

test("medium and low findings stay reviewed-non-blocking: never repair-required, never escalated", () => {
  const nonBlockingDefects = [
    { defectId: "m1", severity: "medium", code: "AUDIO_SILENCE_SEGMENT", sceneId: "intro", repairOwner: "audio-producer", retestRequired: true },
    { defectId: "l1", severity: "low", code: "BLACK_FRAME_SEGMENT", sceneId: "intro", repairOwner: "technical-qa", retestRequired: true }
  ];
  const plan = createRepairPlan({ defects: nonBlockingDefects }, { attempt: 0, maxAttempts: 2 });
  assert.equal(plan.status, "no-action");
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(plan.nonBlocking.map(item => item.defectId), ["m1", "l1"]);
  assert.equal(createRepairPlan({ defects: nonBlockingDefects }, { attempt: 2, maxAttempts: 2 }).status, "no-action", "the retry ceiling cannot escalate non-blocking findings");
  // Critical/high defects stay actionable; non-blocking ones ride along recorded.
  const mixed = createRepairPlan({ defects: [
    { defectId: "h1", severity: "high", sceneId: "intro", repairOwner: "typography-specialist", retestRequired: true },
    ...nonBlockingDefects
  ] }, { attempt: 0, maxAttempts: 2 });
  assert.equal(mixed.status, "repair-required");
  assert.deepEqual(mixed.actions[0].defectIds, ["h1"]);
  assert.deepEqual(mixed.nonBlocking.map(item => item.defectId), ["m1", "l1"]);
});

test("missing render evidence is a critical failure", () => {
  const result = evaluateRenderEvidence(null);
  assert.equal(result.passed, false);
  assert.equal(result.defects[0].severity, "critical");
});

test("converts media-analysis findings into localized render-media defects", () => {
  const scenes = [
    { id: "scene-1", durationFrames: 30 },
    { id: "scene-2", startFrame: 30, durationFrames: 30 },
    { id: "scene-3", durationFrames: 30 }
  ];
  const result = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30, denominator: 1 } }, {
    scenes,
    mediaFindings: [
      { code: "AUDIO_SILENCE_SEGMENT", severity: "high", event: { start: 2, end: 3.5 }, message: "An audio-silence segment exceeded the configured threshold." },
      { code: "AUDIO_PROGRAM_TOO_QUIET", severity: "medium", value: -30, threshold: -24, message: "Integrated program loudness is below the configured delivery range." },
      { code: "BLACK_FRAME_SEGMENT", severity: "medium", event: { start: 0.5, end: 1.25 }, message: "Unexpected black frames occur inside the rendered clip." },
      { code: "OCR_TEXT_OUTSIDE_SAFE_AREA", severity: "medium", atSeconds: 2.6, message: "Recognized text extends beyond the configured safe area." }
    ],
    evidencePath: "renders/master.mp4.render.json"
  });
  assert.equal(result.passed, false);
  assert.equal(result.summary.total, 4);
  const silence = result.defects.find(item => item.code === "AUDIO_SILENCE_SEGMENT");
  assert.deepEqual(silence.timeRangeFrames, { startFrame: 60, endFrame: 105 });
  assert.equal(silence.defectId, "media-audio-silence-segment-f60-905c8570");
  assert.equal(silence.category, "render-media");
  assert.equal(silence.severity, "high");
  assert.equal(silence.repairOwner, "audio-producer");
  assert.equal(silence.sceneId, "scene-3");
  assert.equal(silence.retestRequired, true);
  assert.equal(silence.evidence.path, "renders/master.mp4.render.json");
  const quiet = result.defects.find(item => item.code === "AUDIO_PROGRAM_TOO_QUIET");
  assert.equal(quiet.defectId, "media-audio-program-too-quiet-e524717e");
  assert.equal(quiet.timeRangeFrames, null);
  assert.equal(quiet.sceneId, "project");
  assert.equal(quiet.repairOwner, "audio-producer");
  const black = result.defects.find(item => item.code === "BLACK_FRAME_SEGMENT");
  assert.deepEqual(black.timeRangeFrames, { startFrame: 15, endFrame: 38 });
  assert.equal(black.sceneId, "scene-1");
  assert.deepEqual(black.evidence.sceneIds, ["scene-1", "scene-2"]);
  assert.equal(black.repairOwner, "technical-qa");
  const ocr = result.defects.find(item => item.code === "OCR_TEXT_OUTSIDE_SAFE_AREA");
  assert.deepEqual(ocr.timeRangeFrames, { startFrame: 78, endFrame: 79 });
  assert.equal(ocr.sceneId, "scene-3");
  assert.equal(ocr.repairOwner, "typography-specialist");
});

test("media findings survive when no frame rate is available", () => {
  const result = evaluateRenderEvidence(good, { mediaFindings: [{ code: "FROZEN_FRAME_SEGMENT", severity: "low", event: { start: 1, end: 2 }, message: "Frozen segment." }] });
  assert.equal(result.passed, true);
  const frozen = result.defects.find(item => item.code === "FROZEN_FRAME_SEGMENT");
  assert.equal(frozen.severity, "low");
  assert.equal(frozen.timeRangeFrames, null);
  assert.equal(frozen.sceneId, "project");
});

test("media findings with pre-converted integer ranges keep those frames", () => {
  const result = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30, denominator: 1 } }, {
    scenes: [{ id: "scene-a", durationFrames: 30 }],
    mediaFindings: [{ code: "AUDIO_SILENCE_SEGMENT", severity: "high", timeRangeFrames: { startFrame: 5, endFrame: 9 }, message: "Silence." }]
  });
  const silence = result.defects.find(item => item.code === "AUDIO_SILENCE_SEGMENT");
  assert.deepEqual(silence.timeRangeFrames, { startFrame: 5, endFrame: 9 });
  assert.equal(silence.sceneId, "scene-a");
});

test("media defect ids stay stable when findings change position between cycles", () => {
  const finding = { code: "AUDIO_SILENCE_SEGMENT", severity: "high", event: { start: 2, end: 3.5 }, message: "An audio-silence segment exceeded the configured threshold." };
  const alone = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30, denominator: 1 } }, { mediaFindings: [finding] });
  const preceded = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30, denominator: 1 } }, { mediaFindings: [
    { code: "BLACK_FRAME_SEGMENT", severity: "medium", event: { start: 0.5, end: 1.25 }, message: "Unexpected black frames occur inside the rendered clip." },
    finding
  ] });
  assert.equal(alone.defects[0].defectId, preceded.defects.find(item => item.code === "AUDIO_SILENCE_SEGMENT").defectId);
  // A changed finding (different measured range) changes identity; a byte-equal
  // duplicate of the same event is the only case that falls back to sequence.
  const duplicated = evaluateRenderEvidence({ ...good, fpsRational: { numerator: 30, denominator: 1 } }, { mediaFindings: [finding, structuredClone(finding)] });
  const ids = duplicated.defects.map(item => item.defectId);
  assert.equal(ids[0], alone.defects[0].defectId);
  assert.equal(ids[1], ids[0] + "-x2");
});

test("compiler blocking warnings still become blocking defects", () => {
  const result = evaluateRenderEvidence({ ...good, blockingWarnings: [{ code: "ASSET_REFERENCE_MISSING", message: "Asset intro.png is missing." }] });
  const blocking = result.defects.find(item => item.code === "BLOCKING_ASSET_REFERENCE_MISSING");
  assert.equal(blocking.severity, "high");
  assert.equal(blocking.repairOwner, "engine-router");
  assert.equal(blocking.sceneId, null);
  assert.equal(blocking.timeRangeFrames, null);
});

test("blocking compiler warnings gain scene attribution from the manifest scene timeline", () => {
  const sceneTimeline = [
    { sceneId: "scene-1", startFrame: 0, durationFrames: 180 },
    { sceneId: "scene-2", startFrame: 180, durationFrames: 180 },
    { sceneId: "scene-3", startFrame: 360, durationFrames: 180 }
  ];
  const result = evaluateRenderEvidence({
    ...good,
    sceneTimeline,
    blockingWarnings: [
      { code: "TEXT_OVERFLOW_ESTIMATED", message: "Headline overflows.", sceneId: "scene-2" },
      { code: "ASSET_REFERENCE_MISSING", message: "Asset body.png is missing.", timeRangeFrames: { startFrame: 400, endFrame: 420 } },
      { code: "UNSUPPORTED_LAYER_KIND", message: "Unattributable warning." }
    ]
  });
  const overflow = result.defects.find(item => item.code === "BLOCKING_TEXT_OVERFLOW_ESTIMATED");
  assert.equal(overflow.sceneId, "scene-2");
  assert.deepEqual(overflow.timeRangeFrames, { startFrame: 180, endFrame: 360 });
  const missing = result.defects.find(item => item.code === "BLOCKING_ASSET_REFERENCE_MISSING");
  assert.equal(missing.sceneId, "scene-3");
  assert.deepEqual(missing.timeRangeFrames, { startFrame: 400, endFrame: 420 });
  const unattributed = result.defects.find(item => item.code === "BLOCKING_UNSUPPORTED_LAYER_KIND");
  assert.equal(unattributed.sceneId, null);
  assert.equal(unattributed.timeRangeFrames, null);
});

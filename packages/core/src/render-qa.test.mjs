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
  assert.deepEqual(plan.actions[0].defectIds, ["a", "b"]);
  assert.equal(createRepairPlan(qa, { attempt: 2, maxAttempts: 2 }).status, "escalate");
});

test("missing render evidence is a critical failure", () => {
  const result = evaluateRenderEvidence(null);
  assert.equal(result.passed, false);
  assert.equal(result.defects[0].severity, "critical");
});

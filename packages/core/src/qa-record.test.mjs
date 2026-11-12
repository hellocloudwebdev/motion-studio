import test from "node:test";
import assert from "node:assert/strict";
import { persistQaRecord } from "./qa-record.mjs";

test("persists QA run, repair history and approvals without changing creative intent", () => {
  const project = { schemaVersion: "1.0.0", project: { id: "demo" }, creative: { message: "Keep this" }, scenes: [], qa: { repairHistory: [] } };
  const run = { id: "run-1", createdAt: "2026-11-07T00:00:00.000Z" };
  const first = persistQaRecord(project, {
    run, qaResult: { passed: true, productionReady: true, summary: { total: 0 }, defects: [] },
    repairPlan: { attempt: 0, status: "no-action", actions: [] }
  });
  const approved = persistQaRecord(first, {
    run, qaResult: first.qa.runs[0], repairPlan: { attempt: 0, status: "no-action", actions: [] },
    approval: { approved: true, actor: "producer" }
  });
  assert.equal(project.qa.runs, undefined);
  assert.equal(approved.creative.message, "Keep this");
  assert.equal(approved.qa.runs.length, 1);
  assert.equal(approved.qa.approvals[0].approved, true);
  assert.equal(approved.qa.repairHistory.length, 1);
  assert.equal(approved.qa.repairHistory[0].patch, null);
  assert.equal(approved.qa.repairHistory[0].retestScope, null);
});

test("repair history entries pass through the applied patch and retest scope", () => {
  const project = { schemaVersion: "1.0.0", project: { id: "demo" }, creative: { message: "Keep this" }, scenes: [] };
  const patch = { runId: "run-1", attempt: 0, maxCycles: 2, basedOnIrSha256: "a".repeat(64), ops: [{ type: "set_typography", target: { sceneId: "s", layerId: "t" }, value: { sizePx: 18 } }] };
  const next = persistQaRecord(project, {
    run: { id: "run-1" },
    qaResult: { passed: false, productionReady: false, summary: { total: 1 }, defects: [] },
    repairPlan: { attempt: 0, status: "repair-required", actions: [] },
    patch,
    retestScope: { sceneIds: ["s"], segments: ["renders/repair-1/segments/s.mp4"] }
  });
  const entry = next.qa.repairHistory[0];
  assert.deepEqual(entry.patch, patch);
  assert.deepEqual(entry.retestScope, { sceneIds: ["s"], segments: ["renders/repair-1/segments/s.mp4"] });
  assert.equal(next.creative.message, "Keep this");
});
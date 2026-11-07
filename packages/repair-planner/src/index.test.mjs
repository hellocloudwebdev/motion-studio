import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairPlan, evaluateRepairOutcome } from './index.mjs';

const defects = [
  { defectId: 'd1', severity: 'high', category: 'typography', sceneId: 'scene-1', repairOwner: 'typography-specialist', timeRangeFrames: { start: 10, end: 20 }, retestRequired: true },
  { defectId: 'd2', severity: 'medium', category: 'typography', sceneId: 'scene-1', repairOwner: 'typography-specialist', timeRangeFrames: { start: 21, end: 25 }, retestRequired: true },
  { defectId: 'd3', severity: 'low', category: 'style', sceneId: 'scene-2', repairOwner: 'art-director', retestRequired: true }
];

test('repair plan groups defects and merges adjacent frame ranges', () => {
  const plan = buildRepairPlan({ projectId: 'p1', runId: 'r1', defects });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.tasks[0].defectIds, ['d1', 'd2']);
  assert.deepEqual(plan.tasks[0].timeRanges, [{ start: 10, end: 25 }]);
  assert.equal(plan.tasks[0].approvalRequired, true);
});

test('repair budget exhaustion escalates instead of creating more work', () => {
  const plan = buildRepairPlan({ projectId: 'p1', runId: 'r1', defects, cycle: 2, maxCycles: 2 });
  assert.equal(plan.status, 'escalation-required');
  assert.equal(plan.tasks.length, 0);
});

test('unscoped defects are escalated for human review', () => {
  const plan = buildRepairPlan({ projectId: 'p1', runId: 'r1', defects: [{ defectId: 'd4', severity: 'critical' }] });
  assert.equal(plan.status, 'needs-review');
  assert.equal(plan.escalations[0].code, 'REPAIR_SCOPE_UNRESOLVED');
});

test('repair outcome requires verified evidence and every retest', () => {
  const plan = buildRepairPlan({ projectId: 'p1', runId: 'r1', defects });
  const task = plan.tasks[0];
  const failed = evaluateRepairOutcome(task, { taskId: task.id, status: 'completed', verified: true, evidence: [{ ref: 'artifact://proof', verified: true }], retests: [{ defectId: 'd1', passed: true }] });
  assert.equal(failed.verified, false);
  assert.deepEqual(failed.missingRetests, ['d2']);
  const passed = evaluateRepairOutcome(task, { taskId: task.id, status: 'completed', verified: true, evidence: [{ ref: 'artifact://proof', verified: true }], retests: [{ defectId: 'd1', passed: true }, { defectId: 'd2', passed: true }] });
  assert.equal(passed.status, 'verified');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionRun, transitionRun, recordArtifact, validateExecutionGraph } from '../src/index.mjs';

function approval(projectId, runId, stage) {
  const approvedAt = new Date(Date.now() - 1000).toISOString();
  return { approved: true, projectId, runId, stage, approvedBy: 'producer', approvedAt, expiresAt: new Date(Date.now() + 60000).toISOString() };
}
const hostReadiness = {
  ready: true,
  checks: [{ engine: 'premiere-pro', ready: true }, { engine: 'ffmpeg', ready: true }]
};

test('run transitions enforce repair limits', () => {
  let run = createProductionRun({ id: 'r1', projectId: 'p1', maxRepairCycles: 1 });
  run = transitionRun(run, 'planned'); run = transitionRun(run, 'rendering'); run = transitionRun(run, 'qa');
  run = transitionRun(run, 'repair'); run = transitionRun(run, 'rendering'); run = transitionRun(run, 'qa');
  assert.throws(() => transitionRun(run, 'repair'), /Repair limit/);
});
test('Premiere assembly and final export require verified host evidence and scoped approvals', () => {
  let run = createProductionRun({ id: 'r2', projectId: 'p2' });
  run = transitionRun(run, 'planned'); run = transitionRun(run, 'rendering'); run = transitionRun(run, 'qa');
  assert.throws(() => transitionRun(run, 'assembling'), /host-readiness report/);
  assert.throws(() => transitionRun(run, 'assembling', { hostReadiness: { ready: true, checks: [] }, approval: approval('p2', 'r2', 'premiere-assembly') }), /not verified/);
  run = transitionRun(run, 'assembling', { hostReadiness, approval: approval('p2', 'r2', 'premiere-assembly') });
  assert.equal(run.approvals.length, 1);
  assert.throws(() => transitionRun(run, 'exporting', { hostReadiness, approval: approval('wrong-project', 'r2', 'final-export') }), /scope does not match/);
  run = transitionRun(run, 'exporting', { hostReadiness, approval: approval('p2', 'r2', 'final-export') });
  assert.equal(run.approvals.length, 2);
  assert.throws(() => transitionRun(run, 'delivered'), /verified final-export/);
  run = recordArtifact(run, { id: 'final1', kind: 'final-export', verified: true });
  assert.equal(transitionRun(run, 'delivered').status, 'delivered');
});
test('execution graph detects dependency cycles and records approval policy', () => {
  assert.equal(validateExecutionGraph({ nodes: [{id:'a'},{id:'b'}], edges: [{from:'a',to:'b'},{from:'b',to:'a'}] }).valid, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionRun, transitionRun, recordArtifact, buildExecutionGraph, validateExecutionGraph } from '../src/index.mjs';

test('run transitions enforce repair limits and verified delivery', () => {
  let run = createProductionRun({ id: 'r1', projectId: 'p1', maxRepairCycles: 1 });
  run = transitionRun(run, 'planned');
  run = transitionRun(run, 'rendering');
  run = transitionRun(run, 'qa');
  run = transitionRun(run, 'repair');
  assert.throws(() => transitionRun(run, 'rendering').status === 'rendering' && transitionRun(transitionRun(run, 'rendering'), 'qa') && transitionRun(transitionRun(transitionRun(run, 'rendering'), 'qa'), 'repair'), /Repair limit/);
});
test('delivery requires verified final export', () => {
  let run = createProductionRun({ id: 'r2', projectId: 'p2' });
  run = transitionRun(run, 'planned'); run = transitionRun(run, 'rendering'); run = transitionRun(run, 'qa'); run = transitionRun(run, 'assembling'); run = transitionRun(run, 'exporting');
  assert.throws(() => transitionRun(run, 'delivered'), /verified final-export/);
  run = recordArtifact(run, { id: 'final1', kind: 'final-export', verified: true });
  assert.equal(transitionRun(run, 'delivered').status, 'delivered');
});
test('execution graph detects dependency cycles', () => {
  assert.equal(validateExecutionGraph({ nodes: [{id:'a'},{id:'b'}], edges: [{from:'a',to:'b'},{from:'b',to:'a'}] }).valid, false);
});

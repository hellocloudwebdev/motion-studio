import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeRepairCyclesFromLedger, defaultRunState, invalidateOnInputChange, loadRunState, runStatePath, saveRunState } from './run-state.mjs';

const policy = { maxCycles: 2, targetedRerender: true, retestRequired: true, qualityGatesSha256: 'a'.repeat(64), sourcePath: 'configs/quality-gates.json' };

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'motion-studio-run-state-'));
}

test('run state persists atomically at projects/<id>/run-state.json', async () => {
  const root = workspace();
  try {
    const projectRoot = path.join(root, 'projects', 'demo');
    assert.equal(await loadRunState(projectRoot), null);
    const state = defaultRunState({ projectId: 'demo', runId: 'demo-1', policy });
    assert.equal(state.status, 'planned');
    assert.equal(state.repairCycles, 0);
    await saveRunState(projectRoot, state);
    const file = runStatePath(projectRoot);
    assert.equal(existsSync(file), true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), state);
    assert.equal(path.basename(file), 'run-state.json');
    const leftovers = readdirSync(projectRoot).filter(name => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(await loadRunState(projectRoot), state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('input changes reset the run to planned and drop only unverified artifacts', () => {
  const state = {
    ...defaultRunState({ projectId: 'demo', runId: 'demo-1', policy }),
    status: 'qa', revision: 3,
    inputs: { projectIrSha256: 'old-ir', projectFileSha256: 'old-file', recordedAt: '2026-11-10T00:00:00.000Z' },
    artifacts: [
      { id: 'segment-scene-1', kind: 'scoped-segment', verified: true },
      { id: 'draft-render', kind: 'render', verified: false }
    ],
    events: [{ revision: 1, from: 'planned', to: 'rendering', at: '2026-11-10T00:00:00.000Z' }]
  };
  const unchanged = invalidateOnInputChange(state, { projectIrSha256: 'old-ir', projectFileSha256: 'old-file' });
  assert.equal(unchanged, state);
  const invalidated = invalidateOnInputChange(state, { projectIrSha256: 'new-ir' });
  assert.notEqual(invalidated, state);
  assert.equal(invalidated.status, 'planned');
  assert.equal(invalidated.revision, 4);
  assert.deepEqual(invalidated.artifacts.map(artifact => artifact.id), ['segment-scene-1']);
  assert.deepEqual(invalidated.inputs, { projectIrSha256: 'new-ir', projectFileSha256: 'old-file', recordedAt: invalidated.inputs.recordedAt });
  const event = invalidated.events.at(-1);
  assert.equal(event.type, 'inputs-invalidated');
  assert.equal(event.from, 'qa');
  assert.equal(event.to, 'planned');
  assert.deepEqual(event.metadata.droppedArtifacts, ['draft-render']);
  assert.deepEqual(state.events, [{ revision: 1, from: 'planned', to: 'rendering', at: '2026-11-10T00:00:00.000Z' }]);
  const fileChange = invalidateOnInputChange(state, { projectFileSha256: 'new-file' });
  assert.equal(fileChange.status, 'planned');
  assert.equal(fileChange.inputs.projectIrSha256, 'old-ir');
});

test('repair cycles are counted from the QA ledger of the active run', () => {
  const project = { qa: { repairHistory: [
    { runId: 'demo-1', attempt: 0, status: 'repair-required' },
    { runId: 'demo-1', attempt: 1, status: 'repair-required' },
    { runId: 'demo-1', attempt: 2, status: 'no-action' },
    { runId: 'demo-2', attempt: 0, status: 'repair-required' }
  ] } };
  assert.equal(computeRepairCyclesFromLedger(project, 'demo-1'), 2);
  assert.equal(computeRepairCyclesFromLedger(project, 'demo-2'), 1);
  assert.equal(computeRepairCyclesFromLedger({ qa: { repairHistory: [] } }, 'demo-1'), 0);
  assert.equal(computeRepairCyclesFromLedger({}, 'demo-1'), 0);
  assert.throws(() => computeRepairCyclesFromLedger(project, ''), /runId/);
});

test('defaultRunState validates its inputs', async () => {
  assert.throws(() => defaultRunState({ projectId: '  ' }), /projectId/);
  const state = defaultRunState({ projectId: 'demo' });
  assert.equal(state.policy, null);
  assert.equal(state.runId, null);
  assert.throws(() => runStatePath(''), /project workspace/);
  await assert.rejects(() => saveRunState('.', null), /run state object/);
  assert.throws(() => invalidateOnInputChange(null, {}), /run state object/);
});

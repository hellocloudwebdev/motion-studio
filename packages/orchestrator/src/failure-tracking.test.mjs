import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateProductionStats } from './failure-tracking.mjs';

async function writeProjectFixture(root, { id, repairCycles = 0, executed = 0, escalations = 0, productionReady = null, verifiedMaster = false, runId = null }) {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  const history = [];
  for (let index = 0; index < executed; index += 1) history.push({ status: 'repair-required', attempt: index + 1 });
  for (let index = 0; index < escalations; index += 1) history.push({ status: 'escalated', attempt: 99 });
  const project = {
    schemaVersion: '1.0.0',
    project: { id, name: id, frameRate: { numerator: 30, denominator: 1 } },
    qa: {
      repairHistory: history,
      ...(productionReady !== null ? { gates: [{ id: 'production-ready', status: productionReady ? 'passed' : 'pending' }] } : {})
    }
  };
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  const state = {
    schemaVersion: 1, projectId: id, runId: runId ?? 'run-' + id, status: 'qa',
    repairCycles, updatedAt: '2026-11-17T10:00:00.000Z',
    artifacts: verifiedMaster ? [{ id: 'master-x', kind: 'master-render', path: root + '/' + id + '/render.mp4', verified: true }] : []
  };
  await writeFile(path.join(dir, 'run-state.json'), JSON.stringify(state, null, 2));
}

test('aggregates repair rates, escalations and acceptance across project workspaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-failure-stats-'));
  try {
    await writeProjectFixture(root, { id: 'clean', executed: 0, productionReady: true, verifiedMaster: true, runId: 'run-clean' });
    await writeProjectFixture(root, { id: 'one-repair', executed: 1, productionReady: true, verifiedMaster: true, runId: 'run-one' });
    await writeProjectFixture(root, { id: 'escalated', executed: 2, escalations: 1, productionReady: false, runId: 'run-esc' });
    await writeFile(path.join(root, 'stray-file.txt'), 'ignored');
    const stats = await aggregateProductionStats(root);
    assert.equal(stats.totals.projects, 3);
    assert.equal(stats.totals.runs, 3);
    assert.equal(stats.totals.executedRepairCycles, 3);
    assert.equal(stats.totals.productionReady, 2);
    assert.equal(stats.totals.escalatedProjects, 1);
    assert.equal(stats.totals.repairRate, 1, '3 executed cycles across 3 runs = rate 1.0');
    const oneRepair = stats.projects.find(item => item.projectId === 'one-repair');
    assert.equal(oneRepair.executedRepairCycles, 1);
    assert.equal(oneRepair.verifiedMaster, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing projects root and empty workspaces produce a clean empty report', async () => {
  const missing = await aggregateProductionStats(path.join(os.tmpdir(), 'motion-failure-nonexistent-root'));
  assert.equal(missing.totals.projects, 0);
  assert.equal(missing.totals.repairRate, null);
  assert.equal(missing.note, 'projects root does not exist yet');
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-failure-empty-'));
  try {
    await mkdir(path.join(root, 'just-a-dir'), { recursive: true });
    await writeFile(path.join(root, 'note.txt'), 'no project here');
    const stats = await aggregateProductionStats(root);
    assert.equal(stats.totals.projects, 0);
    assert.equal(stats.note, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

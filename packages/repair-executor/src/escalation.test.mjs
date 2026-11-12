import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildEscalationReport, writeEscalationReport } from './escalation.mjs';

const run = { id: 'run-demo-1', projectId: 'demo', status: 'qa' };
const defects = [
  { defectId: 'qa-001', code: 'ASSET_REFERENCE_MISSING', severity: 'high', sceneId: 'scene-01', repairOwner: 'asset-producer', timeRangeFrames: null, evidence: null },
  { defectId: 'media-001', code: 'FRAME_DECODE_FAILED_2', severity: 'high', sceneId: 'scene-02', repairOwner: 'render-engine', timeRangeFrames: { startFrame: 75, endFrame: 76 }, evidence: { type: 'frame', path: 'frames/f2.png' } }
];

test('escalation reports carry the registry verdict as reasonNotRepaired', () => {
  const report = buildEscalationReport({ run, defects, history: [], attempt: 2, maxCycles: 2 });
  assert.equal(report.schemaVersion, '1.0.0');
  assert.equal(report.type, 'repair-escalation');
  assert.equal(report.projectId, 'demo');
  assert.equal(report.runId, 'run-demo-1');
  assert.equal(report.attempt, 2);
  assert.equal(report.maxCycles, 2);
  assert.equal(report.requestedAction, 'human-review');
  assert.equal(report.unresolvedDefects.length, 2);
  const missing = report.unresolvedDefects[0];
  assert.equal(missing.code, 'ASSET_REFERENCE_MISSING');
  assert.match(missing.reasonNotRepaired, /never invented|verified candidate/);
  const decode = report.unresolvedDefects[1];
  assert.deepEqual(decode.timeRangeFrames, { startFrame: 75, endFrame: 76 });
  assert.match(decode.reasonNotRepaired, /one transient re-render retry/);
  assert.ok(report.createdAt);
  assert.throws(() => buildEscalationReport({ defects, attempt: 1 }), /run with a stable id/);
  assert.throws(() => buildEscalationReport({ run, defects: 'nope', attempt: 1 }), /array of unresolved defects/);
});

test('loop-known verdicts override the registry reason and history entries format as strings', () => {
  const report = buildEscalationReport({
    run, defects: [defects[1]], attempt: 1, maxCycles: 2,
    verdicts: defect => defect.code.startsWith('FRAME_DECODE_FAILED_') ? 'Recurring frame-decode failure at the same frame.' : null,
    history: [{ patchId: 'patch-run-demo-1-a0', status: 'repair-required', attempt: 0, retestResult: 'failed' }, 'free-form entry']
  });
  assert.equal(report.unresolvedDefects[0].reasonNotRepaired, 'Recurring frame-decode failure at the same frame.');
  assert.deepEqual(report.repairHistory, ['patch-run-demo-1-a0 repair-required attempt 0 retest:failed', 'free-form entry']);
});

test('writeEscalationReport writes twin JSON and markdown files per run and attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-escalation-'));
  try {
    const { jsonPath, markdownPath, report } = await writeEscalationReport(root, { run, defects, history: [], attempt: 0, maxCycles: 2 });
    assert.equal(path.basename(jsonPath), 'escalation-run-demo-1-a0.json');
    assert.equal(path.basename(markdownPath), 'escalation-run-demo-1-a0.md');
    const json = JSON.parse(await readFile(jsonPath, 'utf8'));
    assert.deepEqual(json, report);
    const markdown = await readFile(markdownPath, 'utf8');
    assert.match(markdown, /# Repair escalation — demo \/ run-demo-1/);
    assert.match(markdown, /ASSET_REFERENCE_MISSING/);
    assert.match(markdown, /## Unresolved defects/);
    assert.match(markdown, /human-review/);
    await assert.rejects(writeEscalationReport('', { run, defects, attempt: 0 }), /project workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approvePlanningRevision, appendPlanningRevision } from '../src/revision-journal.mjs';

test('persists immutable planning and Canonical IR revisions with exact-hash approvals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-planning-journal-'));
  try {
    const journalPath = path.join(root, 'production.journal.json');
    const planning = { brief: { id: 'brief-1', audience: 'New users' }, script: { narration: 'First version.' } };
    const project = { project: { id: 'explainer', revision: 1 }, scenes: [{ id: 'scene-1' }] };
    const first = await appendPlanningRevision({ journalPath, planning, project, recordedAt: '2026-11-10T00:00:00.000Z' });
    assert.equal(first.revision, 1);
    const nextPlanning = { ...planning, script: { narration: 'Revised version.' } };
    const nextProject = { ...project, project: { ...project.project, revision: 2 } };
    const second = await appendPlanningRevision({ journalPath, planning: nextPlanning, project: nextProject });
    assert.equal(second.revision, 2);
    assert.notEqual(first.planningSha256, second.planningSha256);
    const approval = await approvePlanningRevision({ journalPath, revision: 1, actor: 'producer', note: 'Approved first cut.' });
    assert.equal(approval.canonicalIrSha256, first.canonicalIrSha256);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.revisions.length, 2);
    assert.equal(journal.revisions[0].planning.script.narration, 'First version.');
    assert.equal(journal.revisions[1].canonicalVideoIr.project.revision, 2);
    assert.equal(journal.approvals[0].canonicalIrSha256, journal.revisions[0].canonicalIrSha256);
    await assert.rejects(approvePlanningRevision({ journalPath, revision: 3, actor: 'producer' }), /not present/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a symlinked planning revision journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-planning-journal-link-'));
  try {
    const target = path.join(root, 'target.json'), link = path.join(root, 'linked.json');
    await writeFile(target, JSON.stringify({ schemaVersion: '1.0.0', revisions: [], approvals: [] }));
    try { await symlink(target, link); } catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return; throw error; }
    await assert.rejects(appendPlanningRevision({ journalPath: link, planning: {}, project: { project: { id: 'unsafe' } } }), /symbolic link/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

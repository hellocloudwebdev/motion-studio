import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRunJournal } from './index.mjs';

const event = (revision, overrides = {}) => ({
  eventId: 'evt-' + revision, projectId: 'project-1', runId: 'run-1', revision, type: 'run.created',
  at: '2026-11-07T00:00:00.000Z', payload: { status: revision === 1 ? 'draft' : 'planned' }, ...overrides
});

test('journal appends, replays and enforces contiguous revisions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-journal-'));
  const file = path.join(dir, 'runs', 'events.jsonl');
  try {
    const journal = await openRunJournal(file);
    assert.equal((await journal.append(event(1))).appended, true);
    assert.equal((await journal.append(event(1))).duplicate, true);
    await assert.rejects(journal.append(event(3)), /Revision conflict/);
    assert.equal((await journal.append(event(2, { eventId: 'evt-2', type: 'run.planned' }))).appended, true);
    await journal.close();
    const recovered = await openRunJournal(file);
    assert.equal(recovered.latestRevision('project-1', 'run-1'), 2);
    assert.equal((await recovered.read({ projectId: 'project-1', runId: 'run-1' })).length, 2);
    await recovered.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('journal rejects conflicting event-id reuse', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-journal-'));
  try {
    const journal = await openRunJournal(path.join(dir, 'events.jsonl'));
    await journal.append(event(1));
    await assert.rejects(journal.append(event(1, { payload: { status: 'tampered' } })), /reused with different/);
    await journal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('journal truncates an incomplete final append and preserves valid events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-journal-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    await writeFile(file, JSON.stringify(event(1)) + '\n' + '{"eventId":"partial"');
    const journal = await openRunJournal(file);
    assert.equal(journal.recoveredPartialTail, true);
    assert.equal((await journal.read()).length, 1);
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(event(1)) + '\n');
    await journal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('journal serializes concurrent appends and prevents revision races', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-journal-'));
  try {
    const journal = await openRunJournal(path.join(dir, 'events.jsonl'));
    const results = await Promise.all([
      journal.append(event(1)),
      journal.append(event(2, { eventId: 'evt-2' })),
      journal.append(event(3, { eventId: 'evt-3' }))
    ]);
    assert.equal(results.filter(x => x.appended).length, 3);
    assert.equal(journal.latestRevision('project-1', 'run-1'), 3);
    await journal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

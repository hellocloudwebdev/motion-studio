import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('apps/cli/src/intake.mjs');

test('intake CLI creates a brief and creative workflow files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-intake-'));
  try {
    const input = path.join(dir, 'idea.json');
    const briefPath = path.join(dir, 'brief.json');
    const workflowPath = path.join(dir, 'workflow.json');
    await writeFile(input, JSON.stringify({ idea: 'A launch video for a new design tool', researchRequired: true }));
    const result = spawnSync(process.execPath, [cli, 'create', input, '--output', briefPath, '--workflow', workflowPath], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
    assert.equal(brief.idea, 'A launch video for a new design tool');
    assert.equal(workflow.stages[0].id, 'research');
    assert.equal(workflow.finalOutput, 'canonical-video-ir.json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intake CLI returns a non-zero exit code for an invalid brief', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-intake-'));
  try {
    const input = path.join(dir, 'bad.json');
    await writeFile(input, JSON.stringify({ idea: '   ' }));
    const result = spawnSync(process.execPath, [cli, 'create', input], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /video idea is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intake CLI compiles validated planning artifacts into Canonical Video IR', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-compile-'));
  try {
    const input = path.join(dir, 'planning.json');
    const output = path.join(dir, 'project.json');
    const journal = output + '.journal.json';
    const planning = {
      brief: {
        schemaVersion: '1.0.0', id: 'brief-cli', createdAt: '2026-11-08T00:00:00.000Z',
        idea: 'A launch film', audience: 'Designers', purpose: 'Introduce a product',
        durationSeconds: 10, language: 'English', platform: 'YouTube', aspectRatio: '16:9',
        customDimensions: null, references: [], suppliedAssets: [], research: { required: false }, constraints: []
      },
      creativeDirection: { concept: 'A clear launch', message: 'Make better work', mood: ['confident'] },
      script: { narration: 'A new way to work.', onScreenCopy: ['Make better work'] },
      storyboard: { scenes: [{ id: 'scene-1', name: 'Opening', intent: 'Introduce product', durationFrames: 300, layers: [{ id: 'title', kind: 'text', content: { text: 'Make better work' }, typography: { family: 'Inter', sizePx: 80 } }] }] },
      designSystem: { colors: { background: '#000000', foreground: '#ffffff' }, fonts: [{ family: 'Inter' }] }
    };
    await writeFile(input, JSON.stringify(planning));
    const result = spawnSync(process.execPath, [cli, 'compile', input, '--output', output, '--journal', journal], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
    const project = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(project.schemaVersion, '1.0.0');
    assert.equal(project.scenes[0].layers[0].content.text, 'Make better work');
    const record = JSON.parse(await readFile(journal, 'utf8'));
    assert.equal(record.revisions.length, 1);
    assert.ok(record.revisions[0].canonicalIrSha256);
    const approved = spawnSync(process.execPath, [cli, 'approve-revision', journal, '1', '--actor', 'producer', '--note', 'Reviewed'], { encoding: 'utf8', shell: false });
    assert.equal(approved.status, 0, approved.stderr);
    const updatedJournal = JSON.parse(await readFile(journal, 'utf8'));
    assert.equal(updatedJournal.approvals[0].revision, 1);
    assert.equal(updatedJournal.approvals[0].canonicalIrSha256, record.revisions[0].canonicalIrSha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

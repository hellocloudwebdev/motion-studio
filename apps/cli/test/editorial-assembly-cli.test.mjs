import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('apps/cli/src/index.mjs');
const fixture = {
  schemaVersion: '1.0.0',
  project: { id: 'cli-project', name: 'CLI Project', totalDurationFrames: 60, frameRate: { numerator: 30, denominator: 1 } },
  assets: [],
  scenes: [{ id: 's1', name: 'Opening', durationFrames: 60, layers: [{ id: 'title', kind: 'text', durationFrames: 45 }] }]
};

test('CLI writes and validates an editorial assembly manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-editorial-cli-'));
  try {
    const projectPath = path.join(root, 'project.json');
    const outputPath = path.join(root, 'assembly.json');
    await (await import('node:fs/promises')).writeFile(projectPath, JSON.stringify(fixture));
    const planned = spawnSync(process.execPath, [cli, 'editorial', 'plan', projectPath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const assembly = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(assembly.summary.valid, true);
    assert.equal(assembly.clips[0].track, 'G1');
    const checked = spawnSync(process.execPath, [cli, 'editorial', 'validate', outputPath], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(JSON.parse(checked.stdout).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

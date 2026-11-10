import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('apps/cli/src/index.mjs');

test('CLI exports FCPXML and a provenance sidecar', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'motion-studio-premiere-cli-'));
  try {
    const media = path.join(root, 'hero.mp4');
    const assemblyPath = path.join(root, 'assembly.json');
    const output = path.join(root, 'sequence.fcpxml');
    const manifest = path.join(root, 'handoff.json');
    await writeFile(media, 'test media');
    const checksum = createHash('sha256').update('test media').digest('hex');
    const assembly = { assemblyVersion: '1.0.0', project: { id: 'cli', name: 'CLI', frameRate: { numerator: 30, denominator: 1 } }, sequence: { name: 'CLI sequence', durationFrames: 60 }, scenes: [], clips: [{ clipId: 'clip', sceneId: 'scene', name: 'Clip', kind: 'video', track: 'V1', startFrame: 0, endFrame: 30, durationFrames: 30, sourceInFrame: 0, sourceUri: pathToFileURL(media).href, sourceSha256: checksum, rightsStatus: 'approved', media: true }] };
    await writeFile(assemblyPath, JSON.stringify(assembly));
    const result = spawnSync(process.execPath, [cli, 'premiere', 'export', assemblyPath, '--output', output, '--manifest', manifest], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(await readFile(output, 'utf8'), /<fcpxml version="1.10">/);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(saved.clips[0].clipId, 'clip');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI blocks unsupported interchange content unless the operator explicitly opts in', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'motion-studio-premiere-unsupported-'));
  try {
    const media = path.join(root, 'hero.mp4'), assemblyPath = path.join(root, 'assembly.json');
    const output = path.join(root, 'sequence.fcpxml'), manifest = path.join(root, 'handoff.json');
    await writeFile(media, 'test media');
    const checksum = createHash('sha256').update('test media').digest('hex');
    const assembly = { assemblyVersion: '1.0.0', project: { id: 'cli', name: 'CLI', frameRate: { numerator: 30, denominator: 1 } }, sequence: { name: 'CLI sequence', durationFrames: 60 }, scenes: [], clips: [
      { clipId: 'clip', sceneId: 'scene', name: 'Clip', kind: 'video', track: 'V1', startFrame: 0, endFrame: 30, durationFrames: 30, sourceInFrame: 0, sourceUri: pathToFileURL(media).href, sourceSha256: checksum, rightsStatus: 'approved', media: true },
      { clipId: 'title', sceneId: 'scene', name: 'Title', kind: 'text', track: 'G1', startFrame: 0, endFrame: 30, durationFrames: 30, sourceInFrame: 0, media: false }
    ] };
    await writeFile(assemblyPath, JSON.stringify(assembly));
    const blocked = spawnSync(process.execPath, [cli, 'premiere', 'export', assemblyPath, '--output', output, '--manifest', manifest], { encoding: 'utf8' });
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    const allowed = spawnSync(process.execPath, [cli, 'premiere', 'export', assemblyPath, '--output', output, '--manifest', manifest, '--allow-unsupported'], { encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).unsupportedClips[0].clipId, 'title');
  } finally { await rm(root, { recursive: true, force: true }); }
});

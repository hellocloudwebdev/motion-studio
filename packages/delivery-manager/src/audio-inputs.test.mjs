import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioInputsFromProject } from './audio-inputs.mjs';

test('maps project and scene audio cues to exact rational timeline seconds and mix controls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-audio-inputs-'));
  try {
    await writeFile(path.join(root, 'voice.wav'), 'voice');
    await writeFile(path.join(root, 'music.wav'), 'music');
    const projectFile = path.join(root, 'project.json');
    const project = {
      project: { frameRate: { numerator: 30000, denominator: 1001 } },
      assets: [{ id: 'voice', kind: 'audio', uri: 'voice.wav' }, { id: 'music', kind: 'audio', uri: 'music.wav' }],
      audio: { tracks: [{ assetId: 'music', kind: 'music', offsetFrames: 30, durationFrames: 300, fadeInFrames: 15, fadeOutFrames: 15, duckAgainstNarration: true }] },
      scenes: [{ id: 's1', startFrame: 120, durationFrames: 300, audioCues: [{ assetId: 'voice', kind: 'narration', startFrame: 30, durationFrames: 240, volume: 0.9 }] }]
    };
    const result = await audioInputsFromProject(project, projectFile);
    assert.equal(result.length, 2);
    assert.ok(Math.abs(result[0].offsetSeconds - 30 * 1001 / 30000) < 1e-12);
    assert.ok(Math.abs(result[0].fadeInSeconds - 15 * 1001 / 30000) < 1e-12);
    assert.equal(result[0].duckAgainstNarration, true);
    assert.ok(Math.abs(result[1].offsetSeconds - 150 * 1001 / 30000) < 1e-12);
    assert.ok(Math.abs(result[1].durationSeconds - 240 * 1001 / 30000) < 1e-12);
    assert.equal(result[1].volume, 0.9);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects audio asset paths outside the owning project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-audio-inputs-outside-'));
  try {
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    await writeFile(path.join(root, 'outside.wav'), 'not inside project');
    const project = { project: { frameRate: { numerator: 30, denominator: 1 } }, assets: [{ id: 'voice', kind: 'audio', uri: '../outside.wav' }], audio: { tracks: [{ assetId: 'voice' }] }, scenes: [] };
    await assert.rejects(audioInputsFromProject(project, path.join(projectDir, 'project.json')), /project-relative local path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

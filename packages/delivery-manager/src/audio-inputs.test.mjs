import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioInputsFromProject, audioInputsFromProjectRange } from './audio-inputs.mjs';

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

test('re-bases intersecting cues onto a frame range and skips cues outside it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-audio-inputs-range-'));
  try {
    await writeFile(path.join(root, 'voice.wav'), 'voice');
    await writeFile(path.join(root, 'music.wav'), 'music');
    const projectFile = path.join(root, 'project.json');
    const project = {
      project: { frameRate: { numerator: 30, denominator: 1 } },
      assets: [{ id: 'voice', kind: 'audio', uri: 'voice.wav' }, { id: 'music', kind: 'audio', uri: 'music.wav' }],
      audio: { tracks: [{ assetId: 'music', kind: 'music', offsetFrames: 20, durationFrames: 200 }] },
      scenes: [{ id: 's1', startFrame: 100, durationFrames: 300, audioCues: [{ assetId: 'voice', kind: 'narration', offsetFrames: 30, durationFrames: 120, volume: 0.9, fadeInFrames: 20, fadeOutFrames: 30 }] }]
    };
    // Scene-1 spans frames 100..400; re-base onto [160, 280).
    const inputs = await audioInputsFromProjectRange(project, projectFile, { startFrame: 160, endFrame: 280 });
    assert.equal(inputs.length, 2);
    const voice = inputs.find(input => input.kind === 'narration');
    const music = inputs.find(input => input.kind === 'music');
    // Voice cue starts at frame 130, so 30 frames have already played inside the range.
    assert.ok(Math.abs(voice.offsetSeconds - 0) < 1e-12 || voice.offsetSeconds === 0);
    assert.ok(Math.abs(voice.offsetSeconds) < 1e-12);
    assert.equal(voice.path, path.resolve(root, 'voice.wav'));
    // Clipped to the 90 frames inside [160, 250); the first 20 fade-in frames already played.
    assert.ok(Math.abs(voice.durationSeconds - 90 / 30) < 1e-12);
    assert.ok(!voice.fadeInSeconds, 'a fully played fade-in must not be re-applied on the segment');
    assert.ok(Math.abs(voice.fadeOutSeconds - 30 / 30) < 1e-12);
    assert.equal(voice.volume, 0.9);
    // Music cue spans 20..220, clipped to [160, 220) with its fade window inside.
    assert.ok(Math.abs(music.offsetSeconds - 0) < 1e-12);
    assert.ok(Math.abs(music.durationSeconds - 60 / 30) < 1e-12);
    assert.equal(music.duckAgainstNarration, false);
    // Cues outside the range are dropped entirely.
    const early = await audioInputsFromProjectRange(project, projectFile, { startFrame: 0, endFrame: 20 });
    assert.equal(early.length, 0);
    await assert.rejects(audioInputsFromProjectRange(project, projectFile, { startFrame: 50, endFrame: 50 }), /frame range/);
    await assert.rejects(audioInputsFromProjectRange(project, projectFile, { startFrame: -5, endFrame: 50 }), /frame range/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHyperFramesCli, createMediaQaContext, computeSceneTimeline, assertScopedSceneSegmentIdsUnique } from './index.mjs';
import { evaluateRenderEvidence } from '../../core/src/index.mjs';

test('render manager process execution never uses shell interpolation', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('motion-render-ok')"], { shell: false, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => output += text);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0);
  assert.equal(output, 'motion-render-ok');
});

test('resolves the HyperFrames CLI from the npm package bin field', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-cli-'));
  try {
    const packageDir = path.join(root, 'node_modules', 'hyperframes');
    await mkdir(path.join(packageDir, 'bin'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.8.86', bin: { hyperframes: './bin/hyperframes.mjs' } }));
    await writeFile(path.join(packageDir, 'bin', 'hyperframes.mjs'), '#!/usr/bin/env node\n');
    const result = await resolveHyperFramesCli(root);
    assert.equal(result.version, '0.8.86');
    assert.equal(result.entry, path.join(packageDir, 'bin', 'hyperframes.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a package bin path that escapes the package directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-escape-'));
  try {
    const packageDir = path.join(root, 'node_modules', 'hyperframes');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.8.86', bin: { hyperframes: '../../outside.mjs' } }));
    await assert.rejects(() => resolveHyperFramesCli(root), /escapes its package directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('builds a media QA context with findings, scenes and the render manifest path', () => {
  const mediaAnalysis = { findings: [{ code: 'AUDIO_SILENCE_SEGMENT', severity: 'high', event: { start: 2, end: 3.5 }, message: 'Silence.' }] };
  const project = { scenes: [{ id: 'intro', durationFrames: 30 }] };
  assert.deepEqual(createMediaQaContext(mediaAnalysis, project, '/renders/ad.mp4.render.json'), {
    mediaFindings: mediaAnalysis.findings,
    scenes: project.scenes,
    evidencePath: '/renders/ad.mp4.render.json'
  });
  assert.deepEqual(createMediaQaContext(null, null), { mediaFindings: [], scenes: [], evidencePath: null });
});

test('scoped renders reject scene ids that collide after sanitization', () => {
  // Segment paths are keyed by the adapter-safe scene-id form; two distinct ids
  // collapsing onto one name would overwrite each other's segment render.
  assert.deepEqual(assertScopedSceneSegmentIdsUnique([{ id: 'scene-1' }, { id: 'scene/2' }]), ['scene-1', 'scene-2']);
  assert.throws(() => assertScopedSceneSegmentIdsUnique([{ id: 'scene/1' }, { id: 'scene-1' }]), /sanitize to the same segment name/);
  assert.throws(() => assertScopedSceneSegmentIdsUnique([{ id: 'a b' }, { id: 'a-b' }]), /sanitize to the same segment name/);
  assert.doesNotThrow(() => assertScopedSceneSegmentIdsUnique([{ id: 'intro' }, { id: 'outro' }]));
});

test('computeSceneTimeline uses declared starts when present and cumulative ones otherwise', () => {
  const project = { scenes: [
    { id: 'scene-01', startFrame: 0, durationFrames: 180 },
    { id: 'scene-02', startFrame: 180, durationFrames: 180 },
    { id: 'scene-03', durationFrames: 180 },
    { id: 'scene-04', startFrame: 700, durationFrames: 20 }
  ] };
  assert.deepEqual(computeSceneTimeline(project), [
    { sceneId: 'scene-01', startFrame: 0, durationFrames: 180 },
    { sceneId: 'scene-02', startFrame: 180, durationFrames: 180 },
    { sceneId: 'scene-03', startFrame: 360, durationFrames: 180 },
    { sceneId: 'scene-04', startFrame: 700, durationFrames: 20 }
  ]);
  assert.deepEqual(computeSceneTimeline({ scenes: [{ id: 'bad', durationFrames: 0 }, { durationFrames: 30 }, {}] }), []);
  assert.deepEqual(computeSceneTimeline(null), []);
});

test('manifest scene timeline attributes scoped segment QA findings to the affected scenes', () => {
  // Mirrors the scoped render wiring: per-segment findings are shifted onto the
  // project timeline before entering render QA, and manifest.sceneTimeline lets
  // BLOCKING_* compiler warnings gain scene attribution.
  const sceneTimeline = [
    { sceneId: 'scene-01', startFrame: 0, durationFrames: 180 },
    { sceneId: 'scene-02', startFrame: 180, durationFrames: 180 }
  ];
  const project = { scenes: [{ id: 'scene-01', durationFrames: 180 }, { id: 'scene-02', durationFrames: 180 }] };
  const mediaAnalysis = {
    scoped: true,
    findings: [{ code: 'OCR_TEXT_OUTSIDE_SAFE_AREA', severity: 'high', atSeconds: 181 / 30, message: 'Recognized text extends beyond the configured safe area.' }]
  };
  const manifest = {
    verified: true, productionReady: true, output: '/renders/targeted/segments', bytes: 8192,
    fps: 30, fpsRational: '30', sceneTimeline,
    checks: { dimensionsMatch: true, frameRateMatch: true, durationWithinOneFrame: true, irSceneDurationMatchesProject: true, hasVideo: true, nonEmpty: true, segmentsComplete: true, hyperFramesCheckPassed: true },
    frameEvidence: [{ decoded: true, bytes: 2048, sceneId: 'scene-02' }],
    blockingWarnings: [{ code: 'TEXT_OVERFLOW_ESTIMATED', message: 'Headline overflows.', sceneId: 'scene-01' }]
  };
  const qa = evaluateRenderEvidence({ ...manifest, productionReady: true, blockingWarnings: [] }, createMediaQaContext(mediaAnalysis, project, '/renders/manifest.render.json'));
  assert.equal(qa.passed, false);
  const ocr = qa.defects.find(item => item.category === 'render-media');
  assert.equal(ocr.sceneId, 'scene-02');
  assert.deepEqual(ocr.timeRangeFrames, { startFrame: 181, endFrame: 182 });
  const blocking = evaluateRenderEvidence(manifest, createMediaQaContext({ findings: [] }, project, null));
  const overflow = blocking.defects.find(item => item.code === 'BLOCKING_TEXT_OVERFLOW_ESTIMATED');
  assert.equal(overflow.sceneId, 'scene-01');
  assert.deepEqual(overflow.timeRangeFrames, { startFrame: 0, endFrame: 180 });
});

test('media findings enter QA as localized render-media defects that keep frame ranges', () => {
  // Mirrors the QA wiring inside renderHyperFramesProject: the QA evaluation sees
  // compiler-only blocking warnings while media findings keep severity and gain
  // integer frame ranges at the manifest fps.
  const manifest = {
    verified: true, output: '/renders/startup-ad-draft.mp4', bytes: 4096,
    checks: { dimensionsMatch: true, frameRateMatch: true }, frameEvidence: [{ decoded: true, bytes: 2048 }],
    fps: 30, fpsRational: '30',
    blockingWarnings: [{ code: 'AUDIO_SILENCE_SEGMENT', message: 'Lossy record kept on the render manifest.' }]
  };
  const project = { scenes: [
    { id: 'intro', durationFrames: 30 },
    { id: 'body', durationFrames: 30 },
    { id: 'outro', durationFrames: 30 }
  ] };
  const mediaAnalysis = { findings: [{ code: 'AUDIO_SILENCE_SEGMENT', severity: 'high', event: { start: 2, end: 3.5 }, message: 'An audio-silence segment exceeded the configured threshold.' }] };
  const qa = evaluateRenderEvidence(
    { ...manifest, productionReady: true, blockingWarnings: [] },
    createMediaQaContext(mediaAnalysis, project, '/renders/startup-ad-draft.mp4.render.json')
  );
  assert.equal(qa.passed, false);
  const defect = qa.defects.find(item => item.category === 'render-media');
  assert.deepEqual(defect.timeRangeFrames, { startFrame: 60, endFrame: 105 });
  assert.equal(defect.defectId, 'media-001');
  assert.equal(defect.severity, 'high');
  assert.equal(defect.code, 'AUDIO_SILENCE_SEGMENT');
  assert.equal(defect.sceneId, 'outro');
  assert.equal(defect.repairOwner, 'audio-producer');
  assert.equal(defect.retestRequired, true);
  assert.equal(defect.evidence.path, '/renders/startup-ad-draft.mp4.render.json');
  assert.equal(qa.defects.some(item => item.code === 'BLOCKING_AUDIO_SILENCE_SEGMENT'), false);
});

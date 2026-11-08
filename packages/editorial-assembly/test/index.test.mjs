import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorialAssembly, validateEditorialAssembly } from '../src/index.mjs';

const project = () => ({
  schemaVersion: '1.0.0',
  project: { id: 'launch', name: 'Launch film', revision: 3, totalDurationFrames: 180, frameRate: { numerator: 30000, denominator: 1001 } },
  assets: [
    { id: 'footage', uri: 'media/footage.mp4', sha256: 'a'.repeat(64), metadata: { rightsStatus: 'approved' } },
    { id: 'music', uri: 'media/music.wav', sha256: 'b'.repeat(64), metadata: { rightsStatus: 'needs-review' } }
  ],
  scenes: [
    { id: 'intro', name: 'Intro', durationFrames: 90, layers: [
      { id: 'hero', kind: 'video', assetId: 'footage', startFrame: 0, durationFrames: 90 },
      { id: 'title', kind: 'text', startFrame: 10, durationFrames: 50 },
      { id: 'title-2', kind: 'text', startFrame: 20, durationFrames: 30 }
    ] },
    { id: 'outro', name: 'Outro', durationFrames: 90, layers: [
      { id: 'music', kind: 'audio', assetId: 'music', durationFrames: 90 }
    ] }
  ],
  delivery: { targets: [{ id: 'master', width: 1920, height: 1080 }] }
});

test('builds deterministic scene offsets, clip ranges and media tracks', () => {
  const result = createEditorialAssembly(project());
  assert.equal(result.summary.valid, true);
  assert.deepEqual(result.scenes.map(x => [x.startFrame, x.endFrame]), [[0, 90], [90, 180]]);
  assert.equal(result.clips.find(x => x.clipId === 'music').track, 'A1');
  assert.equal(result.clips.find(x => x.clipId === 'hero').track, 'V1');
  assert.equal(result.clips.find(x => x.clipId === 'title').track, 'G1');
  assert.equal(result.clips.find(x => x.clipId === 'title-2').track, 'G2');
  assert.equal(result.project.frameRate.numerator, 30000);
  assert.equal(result.project.frameRate.denominator, 1001);
  assert.equal(validateEditorialAssembly(result).valid, true);
});

test('reports unresolved media and unapproved rights as warnings, not clearance', () => {
  const input = project();
  input.scenes[0].layers[0].assetId = 'missing';
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, true);
  assert.ok(result.issues.some(x => x.code === 'ASSET_UNRESOLVED'));
  assert.ok(result.issues.some(x => x.code === 'ASSET_RIGHTS_REVIEW_REQUIRED'));
});

test('rejects layers that exceed scene boundaries', () => {
  const input = project();
  input.scenes[0].layers[0].durationFrames = 91;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, false);
  assert.ok(result.issues.some(x => x.code === 'LAYER_OUTSIDE_SCENE'));
});

test('rejects total scene duration beyond the project duration', () => {
  const input = project();
  input.project.totalDurationFrames = 100;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, false);
  assert.ok(result.issues.some(x => x.code === 'ASSEMBLY_EXCEEDS_PROJECT'));
});

test('warns when project duration contains unused tail frames', () => {
  const input = project();
  input.project.totalDurationFrames = 200;
  const result = createEditorialAssembly(input);
  assert.ok(result.issues.some(x => x.code === 'ASSEMBLY_SHORTER_THAN_PROJECT'));
});

test('rejects malformed assembly clips', () => {
  const result = validateEditorialAssembly({ assemblyVersion: '1.0.0', scenes: [], clips: [{ clipId: 'x', startFrame: 8, endFrame: 4, track: 'Z0' }] });
  assert.equal(result.valid, false);
});

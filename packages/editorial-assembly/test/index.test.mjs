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

test('rejects overlapping clips assigned to the same track', () => {
  const result = validateEditorialAssembly({
    assemblyVersion: '1.0.0', scenes: [],
    clips: [
      { clipId: 'a', startFrame: 0, endFrame: 30, track: 'V1' },
      { clipId: 'b', startFrame: 20, endFrame: 40, track: 'V1' }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(x => x.code === 'TRACK_OVERLAP'));
});

test('resolves declared footage in-points against ingested footage metadata', () => {
  const input = project();
  input.assets[0].metadata.footage = { frameCount: 150, rationalFps: { numerator: 30000, denominator: 1001 }, durationSeconds: 5 };
  input.scenes[0].layers[0].inFrame = 30;
  const result = createEditorialAssembly(input);
  const clip = result.clips.find(x => x.clipId === 'hero');
  assert.equal(result.summary.valid, true);
  assert.equal(clip.inFrame, 30);
  assert.equal(clip.sourceInFrame, 30, 'declared in-point must drive sourceInFrame for interchange');
  assert.equal(clip.sourceAssetId, null);
  assert.equal(clip.sourceInPointSeconds, 1.001);
  assert.equal(clip.sourceOutPointSeconds, 4.004);
  assert.equal(clip.footageFrameCount, 150);
  assert.deepEqual(clip.footageFrameRate, { numerator: 30000, denominator: 1001 });
  assert.equal(clip.footageVerified, true);
  assert.equal(result.summary.footageClipCount, 1);
  assert.equal(result.summary.verifiedFootageClipCount, 1);
  assert.ok(!result.issues.some(x => x.code.startsWith('FOOTAGE_')));
});

test('resolves footage metadata from the options registry when the asset record omits it', () => {
  const input = project();
  input.scenes[0].layers[0].sourceAssetId = 'footage';
  delete input.scenes[0].layers[0].assetId;
  const result = createEditorialAssembly(input, {
    footageMetadata: { footage: { frameCount: 120, rationalFps: '30/1' } }
  });
  const clip = result.clips.find(x => x.clipId === 'hero');
  assert.equal(result.summary.valid, true);
  assert.equal(clip.sourceAssetId, 'footage');
  assert.equal(clip.assetId, null);
  assert.equal(clip.inFrame, 0, 'inFrame defaults to 0 when a footage trim is declared');
  assert.equal(clip.sourceInPointSeconds, 0);
  assert.equal(clip.footageFrameCount, 120);
  assert.equal(clip.footageVerified, true);
  assert.ok(!result.issues.some(x => x.code === 'MEDIA_ASSET_REQUIRED'), 'sourceAssetId satisfies media asset resolution');
  assert.ok(!result.issues.some(x => x.code === 'FOOTAGE_METADATA_MISSING'));
  assert.equal(clip.rightsStatus, 'approved', 'rights metadata resolves through sourceAssetId');
});

test('fails closed when the declared in-point range leaves the ingested footage', () => {
  const input = project();
  input.assets[0].metadata.footage = { frameCount: 100, rationalFps: '30000/1001' };
  input.scenes[0].layers[0].inFrame = 30;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, false);
  const finding = result.issues.find(x => x.code === 'FOOTAGE_RANGE_EXCEEDS_SOURCE');
  assert.match(finding.message, /requires source frames 30\.\.120/);
  assert.match(finding.message, /only 100 frames/);
});

test('warns when ingested footage metadata is missing for a declared in-point', () => {
  const input = project();
  input.scenes[0].layers[0].inFrame = 30;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, true);
  assert.ok(result.issues.some(x => x.code === 'FOOTAGE_METADATA_MISSING' && x.severity === 'warning'));
  const clip = result.clips.find(x => x.clipId === 'hero');
  assert.equal(clip.inFrame, 30);
  assert.equal(clip.sourceInPointSeconds, 1.001);
  assert.equal(clip.footageVerified, undefined);
});

test('rejects malformed ingested footage metadata instead of guessing', () => {
  const input = project();
  input.assets[0].metadata.footage = { frameCount: 'many', rationalFps: '30/x', durationSeconds: -4 };
  input.scenes[0].layers[0].inFrame = 30;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, false);
  const finding = result.issues.find(x => x.code === 'FOOTAGE_METADATA_INVALID');
  assert.match(finding.message, /frameCount must be a positive integer/);
  assert.match(finding.message, /rationalFps must be an integer rational/);
  assert.match(finding.message, /durationSeconds must be a non-negative finite number/);
  const clip = result.clips.find(x => x.clipId === 'hero');
  assert.equal(clip.footageFrameCount, undefined);
});

test('warns on frame-rate mismatch between footage and the conforming project rate', () => {
  const input = project();
  input.assets[0].metadata.footage = { frameCount: 150, rationalFps: { numerator: 24, denominator: 1 } };
  input.scenes[0].layers[0].inFrame = 48;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, true);
  const finding = result.issues.find(x => x.code === 'FOOTAGE_FRAME_RATE_MISMATCH');
  assert.match(finding.message, /24\/1 fps/);
  assert.match(finding.message, /30000\/1001 fps/);
  const clip = result.clips.find(x => x.clipId === 'hero');
  assert.equal(clip.sourceInPointSeconds, 48 * 1001 / 30000, 'in-point seconds follow the project frame rate');
  assert.equal(clip.footageVerified, true);
});

test('rejects invalid inFrame declarations and negative ranges', () => {
  const input = project();
  input.assets[0].metadata.footage = { frameCount: 150, rationalFps: '30000/1001' };
  input.scenes[0].layers[0].inFrame = -4;
  const result = createEditorialAssembly(input);
  assert.equal(result.summary.valid, false);
  assert.ok(result.issues.some(x => x.code === 'FOOTAGE_IN_FRAME_INVALID'));
  const validated = validateEditorialAssembly({ assemblyVersion: '1.0.0', scenes: [], clips: [{ clipId: 'x', startFrame: 0, endFrame: 10, track: 'V1', inFrame: -2 }] });
  assert.equal(validated.valid, false);
  assert.ok(validated.issues.some(x => x.code === 'FOOTAGE_IN_FRAME_INVALID'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBlenderScene } from './index.mjs';
import { blenderToolchainAvailable, cornerPixelRgba, decodedFrameSignature } from './test-support.mjs';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../projects/blender-contract-fixtures', import.meta.url));
const fixtureProject = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'project.json'), 'utf8'));
const fixtureScene = id => {
  const scene = fixtureProject.scenes.find(item => item.id === id);
  if (!scene) throw new Error('Fixture scene missing from projects/blender-contract-fixtures/project.json: ' + id);
  return scene;
};

// Deterministic acceptance fixtures: four 12-frame scenes at 480x270 (48
// frames total), each rendered through renderBlenderScene with threads 2 to
// keep the low-power host responsive.
async function renderFixture(id) {
  return renderBlenderScene(fixtureProject, fixtureScene(id), { projectRoot: FIXTURE_ROOT, threads: 2 });
}

test('camera-move fixture renders a verified 12-frame sequence with camera keyframes', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const receipt = await renderFixture('camera-move');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.frameCount, 12);
  assert.equal(receipt.durationFrames, 12);
  assert.equal(receipt.width, 480);
  assert.equal(receipt.height, 270);
  assert.equal(receipt.alpha, false);
  assert.equal(receipt.threads, 2);
  assert.deepEqual(receipt.retriedFrames, []);
  assert.equal(receipt.frameMetadata.width, 480);
  assert.equal(receipt.frameMetadata.height, 270);
  assert.ok(['BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'].includes(receipt.renderer));
  // Camera keyframes must actually change the rendered image, not just the spec.
  assert.notEqual(await decodedFrameSignature(receipt.firstFrame.file), await decodedFrameSignature(receipt.lastFrame.file));
});

test('lighting-variation fixture renders a verified sequence with the overridden two-light rig and material parameters', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const receipt = await renderFixture('lighting-variation');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.frameCount, 12);
  assert.equal(receipt.width, 480);
  assert.equal(receipt.height, 270);
  assert.equal(receipt.alpha, false);
  assert.deepEqual(receipt.retriedFrames, []);
});

test('imported-asset fixture renders a verified sequence from the approved local .glb', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const receipt = await renderFixture('imported-asset');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.frameCount, 12);
  assert.equal(receipt.width, 480);
  assert.equal(receipt.height, 270);
  assert.deepEqual(receipt.retriedFrames, []);
  // Keyframes applied to the imported root must visibly rotate the asset
  // (guards against keyframing an inert rotation channel, e.g. glTF's
  // QUATERNION rotation_mode).
  assert.notEqual(await decodedFrameSignature(receipt.firstFrame.file), await decodedFrameSignature(receipt.lastFrame.file));
});

test('alpha fixture renders film_transparent RGBA frames verified via ffprobe', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const receipt = await renderFixture('alpha');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.frameCount, 12);
  assert.equal(receipt.width, 480);
  assert.equal(receipt.height, 270);
  assert.equal(receipt.alpha, true);
  assert.equal(receipt.metadata.alpha, true);
  assert.equal(receipt.frameMetadata.codec_name, 'png');
  assert.equal(receipt.frameMetadata.pix_fmt, 'rgba');
  // Per-pixel proof: the frame corner sits outside the subject, so with
  // film_transparent it must decode as fully transparent RGBA, not black.
  const corner = await cornerPixelRgba(receipt.firstFrame.file);
  assert.equal(corner.length, 4);
  assert.deepEqual([...corner], [0, 0, 0, 0], 'the film_transparent corner pixel decodes as transparent');
});

test('quality profiles render through the full pipeline and are recorded in the receipt', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const draft = await renderBlenderScene(fixtureProject, fixtureScene('camera-move'), { projectRoot: FIXTURE_ROOT, threads: 2, quality: 'draft' });
  assert.deepEqual(draft.quality, { name: 'draft', samples: 16 });
  assert.equal(draft.metadata.quality.name, 'draft');
  assert.equal(draft.frameCount, 12);
  assert.equal(draft.verified, true);
  const high = await renderBlenderScene(fixtureProject, fixtureScene('camera-move'), { projectRoot: FIXTURE_ROOT, threads: 2, quality: 'high' });
  assert.deepEqual(high.quality, { name: 'high', samples: 128 });
  assert.equal(high.metadata.quality.samples, 128);
  assert.equal(high.frameCount, 12);
  assert.equal(high.verified, true);
});

test('outputContract.renderer cycles selects the path-traced engine', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const cyclesScene = fixtureScene('alpha');
  cyclesScene.outputContract = { alpha: true, renderer: 'cycles' };
  const receipt = await renderBlenderScene(fixtureProject, cyclesScene, { projectRoot: FIXTURE_ROOT, threads: 2, quality: 'draft' });
  assert.equal(receipt.requestedRenderer, 'cycles');
  assert.equal(receipt.renderer, 'CYCLES');
  assert.equal(receipt.metadata.quality.name, 'draft');
  assert.equal(receipt.frameCount, 12);
  assert.equal(receipt.verified, true);
});

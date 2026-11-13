import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGradientImagePlan, generateGradientImage, GRADIENT_IMAGE_TERMS } from '../src/generate-gradient-image.mjs';
import { ffmpegAvailable } from './helpers.mjs';

test('plan builder validates dimensions, palette and seed', () => {
  assert.throws(() => buildGradientImagePlan({ width: 0, height: 100 }), /width must be an integer between 1 and 8192/);
  assert.throws(() => buildGradientImagePlan({ width: 8193, height: 100 }), /width must be an integer between 1 and 8192/);
  assert.throws(() => buildGradientImagePlan({ width: 320.5, height: 100 }), /width must be an integer/);
  assert.throws(() => buildGradientImagePlan({ width: 320, height: 100, palette: ['#000000'] }), /palette must contain 2-8 hex colors/);
  assert.throws(() => buildGradientImagePlan({ width: 320, height: 100, palette: Array(9).fill('#000000') }), /palette must contain 2-8 hex colors/);
  assert.throws(() => buildGradientImagePlan({ width: 320, height: 100, palette: ['#000000', 'red'] }), /palette entries must be hex colors/);
  assert.throws(() => buildGradientImagePlan({ width: 320, height: 100, seed: -1 }), /seed must be an integer/);
});

test('plan builder expands short hex colors and pins the gradients source', () => {
  const plan = buildGradientImagePlan({ width: 640, height: 360, palette: ['#0af', '#0E2A3A'] });
  const source = plan.inputs[0][3];
  assert.ok(source.startsWith('gradients=s=640x360:c0=0x00AAFF:c1=0x0E2A3A:nb_colors=2:seed=42:rate=1'), 'three-digit hex expands and colors pin the source: ' + source);
  assert.deepEqual(plan.params.palette, ['#00AAFF', '#0E2A3A']);
  assert.deepEqual(plan.videoArgs, ['-frames:v', '1'], 'single-frame render');
  assert.deepEqual(buildGradientImagePlan({ width: 640, height: 360 }), buildGradientImagePlan({ width: 640, height: 360 }), 'defaults are deterministic');
});

test('rejects output paths that escape the project workspace before rendering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-gradient-'));
  try {
    await assert.rejects(generateGradientImage({ width: 64, height: 64, projectRoot: root, outputPath: path.join(root, '..', 'g.png') }), /must remain inside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renders an FFprobe-verified PNG with exact dimensions', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-gradient-'));
  try {
    const output = path.join(root, 'assets', 'images', 'backdrop.png');
    const receipt = await generateGradientImage({ width: 320, height: 240, palette: ['#0E2A3A', '#14384E', '#4ADE80'], projectRoot: root, outputPath: output });
    assert.equal(receipt.provider, 'ffmpeg-lavfi');
    assert.equal(receipt.kind, 'image');
    assert.equal(receipt.variant, 'gradient');
    assert.equal(receipt.verified, true);
    assert.equal(receipt.rightsStatus, 'generated');
    assert.equal(receipt.terms, GRADIENT_IMAGE_TERMS);
    assert.equal(receipt.output, output);
    assert.equal(receipt.projectRoot, path.resolve(root));
    assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
    assert.equal(receipt.byteSize, (await stat(output)).size);
    assert.ok(receipt.byteSize > 0);
    assert.deepEqual(receipt.image, { codec: 'png', width: 320, height: 240 });
    assert.equal(receipt.params.seed, 42);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('gradient renders are byte-deterministic per palette and seed', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-gradient-det-'));
  try {
    const options = { width: 320, height: 180, projectRoot: root };
    const first = await generateGradientImage({ ...options, outputPath: path.join(root, 'a.png') });
    const second = await generateGradientImage({ ...options, outputPath: path.join(root, 'b.png') });
    assert.equal(first.sha256, second.sha256, 'same params must render identical bytes');
    const otherSeed = await generateGradientImage({ ...options, outputPath: path.join(root, 'c.png'), seed: 7 });
    assert.notEqual(first.sha256, otherSeed.sha256, 'the seed participates in the render');
    const otherPalette = await generateGradientImage({ ...options, outputPath: path.join(root, 'd.png'), palette: ['#FFFFFF', '#000000'] });
    assert.notEqual(first.sha256, otherPalette.sha256, 'the palette participates in the render');
  } finally { await rm(root, { recursive: true, force: true }); }
});

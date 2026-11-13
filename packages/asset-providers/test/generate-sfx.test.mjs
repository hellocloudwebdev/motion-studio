import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSfxPlan, generateSfx, SFX_KIND_NAMES, SFX_TERMS } from '../src/generate-sfx.mjs';
import { ffmpegAvailable } from './helpers.mjs';

const KINDS = ['whoosh', 'shimmer', 'pop', 'riser', 'impact', 'thud'];

test('exposes the six P3.1 SFX kinds', () => {
  assert.deepEqual([...SFX_KIND_NAMES].sort(), [...KINDS].sort());
});

test('plan builder rejects unknown kinds and out-of-range params', () => {
  assert.throws(() => buildSfxPlan('laser'), /Unknown SFX kind: laser/);
  assert.throws(() => buildSfxPlan('whoosh', { durationSeconds: 0 }), /durationSeconds must be a number between 0.1 and 30/);
  assert.throws(() => buildSfxPlan('whoosh', { durationSeconds: 31 }), /durationSeconds must be a number between 0.1 and 30/);
  assert.throws(() => buildSfxPlan('whoosh', { durationSeconds: '2' }), /durationSeconds/);
  assert.throws(() => buildSfxPlan('thud', { frequency: 500 }), /params.frequency must be a number between 30 and 180/);
  assert.throws(() => buildSfxPlan('shimmer', { frequency: 10 }), /params.frequency must be a number between 800 and 8000/);
  assert.throws(() => buildSfxPlan('pop', { gain: 3 }), /params.gain must be a number between 0 and 2/);
  assert.throws(() => buildSfxPlan('impact', { seed: -1 }), /params.seed must be a number between 0 and/);
});

test('plan builder is pure and deterministic, with per-kind lavfi sources', () => {
  const a = buildSfxPlan('whoosh', { durationSeconds: 1.5 });
  const b = buildSfxPlan('whoosh', { durationSeconds: 1.5 });
  assert.deepEqual(a, b, 'identical params must build identical plans');
  assert.equal(a.params.seed, 1729, 'noise kinds default to a fixed seed for determinism');
  assert.ok(a.inputs.flat().some(arg => arg.startsWith('anoisesrc=')), 'whoosh maps to the seeded pink-noise source');
  const riser = buildSfxPlan('riser', { durationSeconds: 3 });
  assert.ok(riser.inputs.flat().some(arg => arg.startsWith('aevalsrc=')), 'riser maps to an aevalsrc chirp');
  assert.ok(riser.audioArgs[1].includes('\\,'), 'the riser volume expression escapes its filtergraph comma');
  const impact = buildSfxPlan('impact', { durationSeconds: 1.2 });
  assert.equal(impact.inputs.length, 2, 'impact layers a tone and a noise source');
  assert.equal(impact.audioArgs[0], '-filter_complex');
  assert.ok(impact.audioArgs[1].includes('amix=inputs=2'), 'impact mixes its two sources');
  const gained = buildSfxPlan('pop', { gain: 0.5 });
  assert.ok(gained.filters.includes('volume=0.5'), 'gain is applied as a final volume filter');
  assert.deepEqual(buildSfxPlan('pop', {}).params, { kind: 'pop', durationSeconds: 0.35, frequency: 320, gain: 1, seed: 1729 });
});

test('rejects output paths that escape the project workspace before rendering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-sfx-'));
  try {
    await assert.rejects(generateSfx({ kind: 'whoosh', projectRoot: root, outputPath: path.join(root, '..', 'escape.wav') }), /must remain inside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renders all six kinds as FFprobe-verified wav with complete receipts', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-sfx-'));
  try {
    for (const kind of KINDS) {
      const output = path.join(root, 'assets', 'sfx', kind + '.wav');
      const receipt = await generateSfx({ kind, projectRoot: root, outputPath: output, params: kind === 'whoosh' ? { gain: 1.2 } : {} });
      assert.equal(receipt.provider, 'ffmpeg-lavfi');
      assert.equal(receipt.kind, 'sfx');
      assert.equal(receipt.variant, kind);
      assert.equal(receipt.verified, true);
      assert.equal(receipt.rightsStatus, 'generated');
      assert.equal(receipt.terms, SFX_TERMS);
      assert.equal(receipt.projectRoot, path.resolve(root));
      assert.equal(receipt.output, output);
      assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
      assert.equal(receipt.byteSize, (await stat(output)).size);
      assert.ok(receipt.byteSize > 0);
      assert.equal(receipt.audio.codec, 'pcm_s16le');
      assert.equal(receipt.audio.sampleRate, 44100);
      assert.ok(Math.abs(receipt.audio.durationSeconds - receipt.params.durationSeconds) <= Math.max(0.05, receipt.params.durationSeconds * 0.1), kind + ' duration must match the request');
      assert.equal(receipt.params.kind, kind);
    }
    const listing = await readdir(root);
    assert.equal(listing.filter(name => name.startsWith('.asset-sfx-')).length, 0, 'temp files must be cleaned up');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renders are byte-deterministic per params', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-sfx-det-'));
  try {
    const options = { kind: 'whoosh', durationSeconds: 1, projectRoot: root };
    const first = await generateSfx({ ...options, outputPath: path.join(root, 'a.wav') });
    const second = await generateSfx({ ...options, outputPath: path.join(root, 'b.wav') });
    assert.equal(first.sha256, second.sha256, 'same params must render identical bytes');
    const otherSeed = await generateSfx({ ...options, outputPath: path.join(root, 'c.wav'), params: { seed: 99 } });
    assert.notEqual(first.sha256, otherSeed.sha256, 'the noise seed participates in the render');
    const otherGain = await generateSfx({ ...options, outputPath: path.join(root, 'd.wav'), params: { gain: 0.4 } });
    assert.notEqual(first.sha256, otherGain.sha256, 'gain participates in the render');
  } finally { await rm(root, { recursive: true, force: true }); }
});

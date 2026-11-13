import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMusicBedPlan, generateMusicBed, MUSIC_TERMS, parseMusicKey } from '../src/generate-music-bed.mjs';
import { ffmpegAvailable } from './helpers.mjs';

test('parses musical key names into root semitones', () => {
  assert.deepEqual(parseMusicKey('C'), { name: 'C', semitone: 0, minor: false });
  assert.deepEqual(parseMusicKey('Am'), { name: 'Am', semitone: 9, minor: true });
  assert.deepEqual(parseMusicKey('F#'), { name: 'F#', semitone: 6, minor: false });
  assert.deepEqual(parseMusicKey('Bbm'), { name: 'Bbm', semitone: 10, minor: true });
  for (const bad of ['H', 'c', 'Cmaj', 'F##m', '']) assert.throws(() => parseMusicKey(bad), /key must be a note name/);
});

test('plan builder validates duration, bpm and mood', () => {
  assert.throws(() => buildMusicBedPlan({ durationSeconds: 1 }), /durationSeconds must be a number between 2 and 600/);
  assert.throws(() => buildMusicBedPlan({ durationSeconds: 601 }), /durationSeconds must be a number between 2 and 600/);
  assert.throws(() => buildMusicBedPlan({ durationSeconds: 10, bpm: 39 }), /bpm must be an integer between 40 and 220/);
  assert.throws(() => buildMusicBedPlan({ durationSeconds: 10, bpm: 96.5 }), /bpm must be an integer/);
  assert.throws(() => buildMusicBedPlan({ durationSeconds: 10, mood: 'epic' }), /Unknown mood: epic/);
});

test('plan builder layers four chord segments plus a triangle bass drone', () => {
  const plan = buildMusicBedPlan({ durationSeconds: 8, key: 'C', bpm: 96, mood: 'uplift' });
  assert.equal(plan.inputs.length, 13, 'twelve chord tones (3 per segment, mixed in-graph) plus one bass drone');
  assert.deepEqual(plan.params.chords, ['C', 'G', 'Am', 'F'], 'uplift maps to I-V-vi-IV');
  assert.equal(plan.params.secondsPerChord, 2);
  assert.ok(plan.audioArgs[1].includes('concat=n=4:v=0:a=1'), 'chord segments concatenate into the progression');
  assert.ok(plan.audioArgs[1].includes('aformat=channel_layouts=stereo'), 'the mix is delivered in stereo');
  assert.ok(plan.inputs[12][3].includes('asin(sin(2*PI*65.4064*t))'), 'bass is a triangle wave (asin(sin)) one octave below the key root');
  assert.deepEqual(buildMusicBedPlan({ durationSeconds: 8 }), plan, 'defaults are deterministic: C, 96 bpm, uplift');
  const tense = buildMusicBedPlan({ durationSeconds: 8, key: 'Am', mood: 'tense' });
  assert.deepEqual(tense.params.chords, ['Am', 'F', 'C', 'G'], 'tense maps to i-VI-III-VII');
  const again = buildMusicBedPlan({ durationSeconds: 8, key: 'Am', mood: 'tense' });
  assert.deepEqual(again, tense);
});

test('rejects output paths that escape the project workspace before rendering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-bed-'));
  try {
    await assert.rejects(generateMusicBed({ durationSeconds: 4, projectRoot: root, outputPath: path.join(root, '..', 'bed.wav') }), /must remain inside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renders an FFprobe-verified stereo music bed with complete receipts', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-bed-'));
  try {
    const output = path.join(root, 'assets', 'music', 'bed.wav');
    const receipt = await generateMusicBed({ durationSeconds: 4, key: 'Am', bpm: 90, mood: 'tense', projectRoot: root, outputPath: output });
    assert.equal(receipt.provider, 'ffmpeg-lavfi');
    assert.equal(receipt.kind, 'music-bed');
    assert.equal(receipt.verified, true);
    assert.equal(receipt.rightsStatus, 'generated');
    assert.equal(receipt.terms, MUSIC_TERMS);
    assert.equal(receipt.output, output);
    assert.equal(receipt.projectRoot, path.resolve(root));
    assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
    assert.equal(receipt.byteSize, (await stat(output)).size);
    assert.ok(receipt.byteSize > 0);
    assert.equal(receipt.audio.codec, 'pcm_s16le');
    assert.equal(receipt.audio.sampleRate, 44100);
    assert.equal(receipt.audio.channels, 2);
    assert.ok(Math.abs(receipt.audio.durationSeconds - 4) <= 0.1);
    assert.deepEqual(receipt.params.chords, ['Am', 'F', 'C', 'G']);
    assert.deepEqual(receipt.params.bpm, 90);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('music beds are byte-deterministic per params and key-sensitive', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-bed-det-'));
  try {
    const options = { durationSeconds: 3, projectRoot: root };
    const first = await generateMusicBed({ ...options, outputPath: path.join(root, 'a.wav') });
    const second = await generateMusicBed({ ...options, outputPath: path.join(root, 'b.wav') });
    assert.equal(first.sha256, second.sha256, 'same params must render identical bytes');
    const otherKey = await generateMusicBed({ ...options, outputPath: path.join(root, 'c.wav'), key: 'C#m', mood: 'tense' });
    assert.notEqual(first.sha256, otherKey.sha256, 'the key participates in the render');
  } finally { await rm(root, { recursive: true, force: true }); }
});

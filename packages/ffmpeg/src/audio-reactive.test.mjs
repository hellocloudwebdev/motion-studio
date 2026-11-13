import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMediaCommand } from './index.mjs';
import { analyzeAudioEnvelope, buildAudioEnvelopeProbePlan, downsampleEnvelope, envelopeToChartData, escapeAmovieFilename, validateAudioEnvelope } from './audio-reactive.mjs';

async function withTempAudio(name, lavfi, extraArgs = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-audio-envelope-'));
  const file = path.join(dir, name);
  try {
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', lavfi, ...extraArgs, '-c:a', 'pcm_s16le', '-ar', '48000', file]);
    return { dir, file };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const DYNAMIC_SINE = "sine=frequency=440:duration=4,volume=volume='0.05+0.85*abs(sin(2*PI*t))':eval=frame";

test('audio envelope probe plan escapes the amovie path per ffmpeg filtergraph rules', () => {
  const plan = buildAudioEnvelopeProbePlan({ audioPath: 'C:\\audio\\beat.wav', fps: 30, windowFrames: 1, sampleRate: 48000, durationSeconds: 4 });
  assert.equal(plan.executable, 'ffprobe');
  assert.equal(plan.filter, "amovie='C\\:/audio/beat.wav',asetnsamples=n=1600:p=0,astats=metadata=1:reset=1");
  assert.equal(plan.durationFrames, 120);
  assert.equal(plan.expectedWindows, 120);
  const grouped = buildAudioEnvelopeProbePlan({ audioPath: 'C:\\audio\\beat.wav', fps: 30, windowFrames: 4, sampleRate: 48000, durationSeconds: 4 });
  assert.equal(grouped.expectedWindows, 30);
  assert.match(grouped.filter, /astats=metadata=1:reset=4/);
  // 4.033333s of audio at 30fps rounds to 121 frames; fractional fps accepts rationals.
  const odd = buildAudioEnvelopeProbePlan({ audioPath: 'C:\\audio\\beat.wav', fps: { numerator: 30, denominator: 1 }, sampleRate: 44100, durationSeconds: 4.0333333 });
  assert.equal(odd.durationFrames, 121);
  assert.equal(odd.samplesPerFrame, Math.round(44100 / 30));
});

test('audio envelope probe plan rejects unsafe paths and invalid settings', () => {
  assert.throws(() => buildAudioEnvelopeProbePlan({ audioPath: '', fps: 30, sampleRate: 48000, durationSeconds: 4 }), /non-empty path/);
  assert.throws(() => buildAudioEnvelopeProbePlan({ audioPath: 'a.wav', fps: 0, sampleRate: 48000, durationSeconds: 4 }), /fps must be/);
  assert.throws(() => buildAudioEnvelopeProbePlan({ audioPath: 'a.wav', fps: 30, windowFrames: 0, sampleRate: 48000, durationSeconds: 4 }), /windowFrames must be/);
  assert.throws(() => buildAudioEnvelopeProbePlan({ audioPath: 'a.wav', fps: 30, sampleRate: 0, durationSeconds: 4 }), /sampleRate must be/);
  assert.throws(() => buildAudioEnvelopeProbePlan({ audioPath: "a'b.wav", fps: 30, sampleRate: 48000, durationSeconds: 4 }), /single quote/);
});

test('analyzes a dynamic 4s sine into exactly one RMS window per frame', async () => {
  const { dir, file } = await withTempAudio('beat.wav', DYNAMIC_SINE);
  try {
    const envelope = await analyzeAudioEnvelope({ audioPath: file, fps: 30 });
    assert.equal(envelope.fps, 30);
    assert.equal(envelope.windowFrames, 1);
    assert.equal(envelope.durationFrames, 120);
    assert.equal(envelope.windows.length, 120);
    assert.deepEqual(envelope.windows.slice(0, 3).map(w => [w.startFrame, w.endFrame]), [[0, 1], [1, 2], [2, 3]]);
    assert.equal(envelope.windows[119].endFrame, 120);
    // Dynamics are real: quiet tail differs from the loud peak, and values sit in a sane dBFS range.
    const levels = envelope.windows.map(w => w.rmsDb);
    assert.equal(new Set(levels).size > 12, true);
    assert.equal(Math.max(...levels) <= 0, true);
    assert.equal(validateAudioEnvelope(envelope), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('windowFrames groups frames and keeps window boundaries inside the duration', async () => {
  const { dir, file } = await withTempAudio('beat.wav', DYNAMIC_SINE);
  try {
    const envelope = await analyzeAudioEnvelope({ audioPath: file, fps: 30, windowFrames: 4 });
    assert.equal(envelope.windows.length, 30);
    assert.equal(envelope.windows[0].startFrame, 0);
    assert.equal(envelope.windows[0].endFrame, 4);
    assert.equal(envelope.windows[29].endFrame, 120);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same input produces byte-identical envelope JSON (determinism)', async () => {
  const { dir, file } = await withTempAudio('beat.wav', DYNAMIC_SINE);
  try {
    const first = JSON.stringify(await analyzeAudioEnvelope({ audioPath: file, fps: 30, windowFrames: 2 }), null, 2);
    const second = JSON.stringify(await analyzeAudioEnvelope({ audioPath: file, fps: 30, windowFrames: 2 }), null, 2);
    assert.equal(first, second);
    assert.doesNotMatch(first, /createdAt|generatedAt|timestamp/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('digital silence is clamped to the -60 dB floor marker', async () => {
  const { dir, file } = await withTempAudio('silent.wav', 'anullsrc=r=48000:cl=mono', ['-t', '2']);
  try {
    const envelope = await analyzeAudioEnvelope({ audioPath: file, fps: 30, windowFrames: 2 });
    assert.equal(envelope.windows.length, 30);
    assert.ok(envelope.windows.every(w => w.rmsDb === -60));
    const chart = envelopeToChartData(envelope);
    assert.ok(chart.every(point => point.value === 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paths containing a single quote analyze through a byte-identical temp copy', async () => {
  const { dir, file } = await withTempAudio("it's a beat.wav", 'sine=frequency=330:duration=1');
  try {
    const envelope = await analyzeAudioEnvelope({ audioPath: file, fps: 30 });
    assert.equal(envelope.durationFrames, 30);
    assert.equal(envelope.windows.length, 30);
    assert.ok(envelope.windows.every(w => Number.isFinite(w.rmsDb)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('envelopeToChartData normalizes rmsDb to 0..1 chart points with clamping', () => {
  const envelope = { fps: 30, windowFrames: 2, durationFrames: 8, windows: [
    { startFrame: 0, endFrame: 2, rmsDb: -60 },
    { startFrame: 2, endFrame: 4, rmsDb: -30 },
    { startFrame: 4, endFrame: 6, rmsDb: 0 },
    { startFrame: 6, endFrame: 8, rmsDb: -80 }
  ] };
  const chart = envelopeToChartData(envelope);
  assert.deepEqual(chart, [
    { label: '0', value: 0 },
    { label: '2', value: 0.5 },
    { label: '4', value: 1 },
    { label: '6', value: 0 }
  ]);
  const custom = envelopeToChartData(envelope, { floorDb: -50, ceilDb: -10 });
  assert.equal(custom[1].value, 0.5);
  assert.equal(custom[2].value, 1);
  assert.throws(() => envelopeToChartData(envelope, { floorDb: 0, ceilDb: -60 }), /ceilDb must be/);
  assert.throws(() => envelopeToChartData({ ...envelope, windows: [] }), /at least one window/);
  assert.throws(() => envelopeToChartData({ ...envelope, windowFrames: 0 }), /windowFrames must be/);
  assert.throws(() => envelopeToChartData({ ...envelope, windows: [{ startFrame: -1, endFrame: 2, rmsDb: -10 }] }), /valid integer startFrame/);
});

test('downsampleEnvelope keeps the loudest window of each bucket and is deterministic', () => {
  const windows = Array.from({ length: 120 }, (_, i) => ({ startFrame: i, endFrame: i + 1, rmsDb: i % 4 === 0 ? -10 - (i % 5) : -40 - (i % 7) }));
  const envelope = { fps: 30, windowFrames: 1, durationFrames: 120, windows };
  const reduced = downsampleEnvelope(envelope, 100);
  assert.equal(reduced.windows.length, 100);
  // Bucket-max: every kept window is the loudest of its contiguous source range.
  for (const [index, kept] of reduced.windows.entries()) {
    const start = Math.floor(index * 120 / 100);
    const end = Math.max(start + 1, Math.floor((index + 1) * 120 / 100));
    const bucket = windows.slice(start, end);
    assert.equal(kept.rmsDb, Math.max(...bucket.map(w => w.rmsDb)));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(downsampleEnvelope(envelope, 100))), JSON.parse(JSON.stringify(reduced)));
  // Envelopes within the cap pass through unchanged.
  assert.equal(downsampleEnvelope(envelope, 120), envelope);
  assert.equal(downsampleEnvelope(envelope, 200), envelope);
  assert.throws(() => downsampleEnvelope(envelope, 0), /maxWindows must be/);
});

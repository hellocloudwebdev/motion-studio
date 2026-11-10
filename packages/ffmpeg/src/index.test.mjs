import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTranscodePlan, buildProbePlan, buildFinalizationPlan, parseProbeOutput, renderCaptions, runMediaCommand, finalizeMedia } from './index.mjs';

test('transcode plan uses an argument array and explicit paths', () => {
  const plan = buildTranscodePlan({ input: 'source.mp4', output: 'final.mp4', width: 1920, height: 1080, fps: 30 });
  assert.equal(plan.executable, 'ffmpeg');
  assert.ok(Array.isArray(plan.args));
  assert.ok(plan.args.includes('-i'));
});
test('transcode plan rejects identical input and output paths', () => assert.throws(() => buildTranscodePlan({ input: 'same.mp4', output: 'same.mp4', width: 1920, height: 1080, fps: 30 }), /must differ/));
test('probe plan is safe and parseable', () => {
  assert.equal(buildProbePlan({ input: 'clip.mp4' }).executable, 'ffprobe');
  const parsed = parseProbeOutput(JSON.stringify({ format: { duration: '5' }, streams: [{ codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30/1', codec_name: 'h264' }] }));
  assert.equal(parsed.width, 1280);
  assert.equal(parsed.hasAudio, false);
});

test('finalization builds explicit safe audio mix and video mappings', () => {
  const plan = buildFinalizationPlan({ input: 'source.mp4', output: 'final.mp4', width: 1280, height: 720, fps: 30, durationSeconds: 4, audioInputs: [{ path: 'voice.wav', kind: 'narration', offsetSeconds: 0.5 }] });
  assert.equal(plan.executable, 'ffmpeg');
  assert.ok(plan.args.includes('[aout]'));
  assert.ok(plan.args.includes('[vout]'));
  assert.equal(plan.expected.hasAudio, true);
  assert.equal(plan.expected.durationSeconds, 4);
  assert.ok(plan.args.includes('4.000000'));
  const mix = buildFinalizationPlan({ input: 'picture.mp4', output: 'mixed.mp4', width: 1280, height: 720, fps: 30, durationSeconds: 4, audioInputs: [
    { path: 'voice.wav', kind: 'narration', durationSeconds: 3, fadeInSeconds: 0.1, fadeOutSeconds: 0.2 },
    { path: 'music.wav', kind: 'music', durationSeconds: 4, fadeInSeconds: 0.4, fadeOutSeconds: 0.5, duckAgainstNarration: true }
  ] });
  const filters = mix.args[mix.args.indexOf('-filter_complex') + 1];
  assert.match(filters, /afade=t=in:st=0:d=0\.400000/);
  assert.match(filters, /afade=t=out:st=3\.500000:d=0\.500000/);
  assert.match(filters, /sidechaincompress/);
  assert.throws(() => buildFinalizationPlan({ input: 'a.mp4', output: 'b.mp4', width: 1280, height: 720, fps: 30, audioInputs: [{ path: 'music.wav', kind: 'music', duckAgainstNarration: true }] }), /requires at least one narration/);
  assert.throws(() => buildFinalizationPlan({ input: 'a.mp4', output: 'b.mp4', width: 1280, height: 720, fps: 30, audioRequired: true }), /requires audio/);
});

test('captions convert integer frame ranges to SRT and VTT timestamps', () => {
  const cues = [{ startFrame: 30, endFrame: 75, text: 'Hello world' }];
  assert.equal(renderCaptions(cues, { numerator: 30, denominator: 1 }, 'srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello world\n');
  assert.equal(renderCaptions(cues, { numerator: 30, denominator: 1 }, 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n');
  assert.throws(() => renderCaptions([{ startFrame: 2, endFrame: 1, text: '' }], { numerator: 30, denominator: 1 }), /valid integer frame range/);
});

test('FFmpeg mixes, trims, fades and ducks real audio tracks into a verified MP4', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ffmpeg-mix-'));
  try {
    const picture = path.join(root, 'picture.mp4'), narration = path.join(root, 'narration.wav'), music = path.join(root, 'music.wav'), output = path.join(root, 'master.mp4');
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x233344:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', picture]);
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.8', '-c:a', 'pcm_s16le', narration]);
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=2', '-c:a', 'pcm_s16le', music]);
    const result = await finalizeMedia({ input: picture, output, width: 320, height: 180, fps: 30, durationSeconds: 2, audioRequired: true, audioInputs: [
      { path: narration, kind: 'narration', durationSeconds: 1.8, fadeInSeconds: 0.05, fadeOutSeconds: 0.1, volume: 0.8 },
      { path: music, kind: 'music', durationSeconds: 2, fadeInSeconds: 0.2, fadeOutSeconds: 0.3, volume: 0.3, duckAgainstNarration: true }
    ] });
    assert.equal(result.verified, true);
    assert.equal(result.media.hasAudio, true);
    assert.equal(result.media.width, 320);
    assert.ok(Math.abs(result.media.durationSeconds - 2) < 0.04);
  } finally { await rm(root, { recursive: true, force: true }); }
});

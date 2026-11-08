import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscodePlan, buildProbePlan, buildFinalizationPlan, parseProbeOutput, renderCaptions } from './index.mjs';

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
  assert.throws(() => buildFinalizationPlan({ input: 'a.mp4', output: 'b.mp4', width: 1280, height: 720, fps: 30, audioRequired: true }), /requires audio/);
});

test('captions convert integer frame ranges to SRT and VTT timestamps', () => {
  const cues = [{ startFrame: 30, endFrame: 75, text: 'Hello world' }];
  assert.equal(renderCaptions(cues, { numerator: 30, denominator: 1 }, 'srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello world\n');
  assert.equal(renderCaptions(cues, { numerator: 30, denominator: 1 }, 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n');
  assert.throws(() => renderCaptions([{ startFrame: 2, endFrame: 1, text: '' }], { numerator: 30, denominator: 1 }), /valid integer frame range/);
});

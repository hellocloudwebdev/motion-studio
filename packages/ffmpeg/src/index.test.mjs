import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscodePlan, buildProbePlan, parseProbeOutput } from './index.mjs';

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

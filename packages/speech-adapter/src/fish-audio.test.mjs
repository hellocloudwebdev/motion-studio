import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateFishAudioSpeech, resolveFishAudioOptions, FISH_AUDIO_DEFAULT_MODEL, FISH_AUDIO_TERMS_NOTE } from './fish-audio.mjs';

const TEST_API_KEY = 'fish-test-key-not-a-real-credential';

function ffmpegAvailable() {
  try { return spawnSync('ffprobe', ['-version'], { stdio: 'ignore', shell: false }).status === 0; }
  catch { return false; }
}

// Synthesizes a valid 16-bit PCM wav: a constant tone followed by trailing silence,
// so the shared FFmpeg silence trim has something measurable to remove.
function wavBytes({ durationSeconds = 1, trailingSilenceSeconds = 0.5, sampleRate = 44100, channels = 1, frequency = 440 } = {}) {
  const toneSamples = Math.floor(durationSeconds * sampleRate), silentSamples = Math.floor(trailingSilenceSeconds * sampleRate);
  const dataLength = (toneSamples + silentSamples) * channels * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < toneSamples * channels; index++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * Math.floor(index / channels)) / sampleRate) * 12000), 44 + index * 2);
  return buffer;
}

function audioResponse(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/wav' } });
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ message, status }), { status, headers: { 'content-type': 'application/json' } });
}

test('resolves Fish Audio credentials from the environment and requires a key', () => {
  assert.throws(() => resolveFishAudioOptions({}), /FISH_AUDIO_API_KEY \(or FISH_API_KEY\) is required/);
  assert.throws(() => resolveFishAudioOptions({ FISH_API_KEY: ' ' }), /FISH_AUDIO_API_KEY \(or FISH_API_KEY\) is required/);
  assert.deepEqual(resolveFishAudioOptions({ FISH_AUDIO_API_KEY: TEST_API_KEY }), { apiKey: TEST_API_KEY, model: FISH_AUDIO_DEFAULT_MODEL, voiceId: undefined });
  assert.deepEqual(resolveFishAudioOptions({ FISH_API_KEY: TEST_API_KEY, FISH_AUDIO_MODEL: 's1' }), { apiKey: TEST_API_KEY, model: 's1', voiceId: undefined });
  assert.deepEqual(resolveFishAudioOptions({ FISH_AUDIO_API_KEY: TEST_API_KEY, FISH_AUDIO_MODEL: 'env-model' }, { model: 'flag-model' }), { apiKey: TEST_API_KEY, model: 'flag-model', voiceId: undefined });
  assert.equal(resolveFishAudioOptions({ FISH_AUDIO_API_KEY: TEST_API_KEY, FISH_AUDIO_VOICE_ID: '  voice-from-env  ' }).voiceId, 'voice-from-env');
  assert.equal(resolveFishAudioOptions({ FISH_AUDIO_API_KEY: TEST_API_KEY }, { voiceId: 'flag-voice' }).voiceId, 'flag-voice');
});

test('rejects speech generation before any network call when no key is configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-speech-fish-'));
  try {
    let fetchCalled = false;
    await assert.rejects(generateFishAudioSpeech('Hello.', { projectRoot: root, outputPath: path.join(root, 'out.wav'), env: {}, fetchImpl: async () => { fetchCalled = true; return audioResponse(wavBytes()); } }), /FISH_AUDIO_API_KEY \(or FISH_API_KEY\) is required/);
    assert.equal(fetchCalled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maps Fish Audio HTTP errors to clear messages without echoing the key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-speech-fish-'));
  try {
    for (const [status, message] of [[401, 'Invalid API key'], [429, 'Rate limit exceeded, retry later']]) {
      await assert.rejects(
        generateFishAudioSpeech('Hello.', { projectRoot: root, outputPath: path.join(root, 'assets', 'narration', 'segment-001.wav'), apiKey: TEST_API_KEY, fetchImpl: async () => errorResponse(status, message) }),
        new RegExp('Fish Audio TTS API returned ' + status + ': ' + message)
      );
    }
    await assert.rejects(
      generateFishAudioSpeech('Hello.', { projectRoot: root, outputPath: path.join(root, 'out.wav'), apiKey: TEST_API_KEY, fetchImpl: async () => errorResponse(500, 'provider exploded') }),
      /Fish Audio TTS API returned 500: provider exploded/
    );
    const listing = await readdir(path.join(root, 'assets', 'narration'));
    assert.equal(listing.filter(name => name.startsWith('.speech-fish-')).length, 0, 'failed requests must not leave temp files behind');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects output paths that escape the project workspace before contacting the provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-speech-fish-'));
  try {
    let fetchCalled = false;
    await assert.rejects(generateFishAudioSpeech('Unsafe output path.', { projectRoot: root, outputPath: path.join(root, '..', 'outside.wav'), apiKey: TEST_API_KEY, fetchImpl: async () => { fetchCalled = true; return audioResponse(wavBytes()); } }), /must remain inside/);
    assert.equal(fetchCalled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generates verified, silence-trimmed wav output through the Fish Audio contract', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-speech-fish-'));
  try {
    const requests = [];
    const fetchImpl = async (url, options) => { requests.push({ url, options }); return audioResponse(wavBytes({ durationSeconds: 2, trailingSilenceSeconds: 0.5 })); };
    const output = path.join(root, 'assets', 'narration', 'segment-001.wav');
    const receipt = await generateFishAudioSpeech('Hello from Fish Audio.', { projectRoot: root, outputPath: output, apiKey: TEST_API_KEY, fetchImpl, timeoutMs: 30_000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.fish.audio/v1/tts');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.model, FISH_AUDIO_DEFAULT_MODEL, 'the model id travels in the model header');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + TEST_API_KEY);
    assert.deepEqual(JSON.parse(requests[0].options.body), { text: 'Hello from Fish Audio.', format: 'wav', sample_rate: 44100 });
    assert.equal(receipt.provider, 'fish-audio');
    assert.equal(receipt.model, FISH_AUDIO_DEFAULT_MODEL);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.output, output);
    assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
    assert.equal(receipt.byteSize, (await stat(output)).size);
    assert.ok(receipt.byteSize > 0);
    assert.equal(receipt.audio.sampleRate, 44100);
    assert.equal(receipt.audio.channels, 1);
    assert.ok(receipt.audio.durationSeconds > receipt.sourceAudioDurationSeconds * 0.5, 'the narration body must survive the trim');
    assert.ok(receipt.sourceAudioDurationSeconds > receipt.audio.durationSeconds, 'trailing silence must be trimmed');
    assert.ok(receipt.trailingSilenceTrimmed > 0);
    assert.deepEqual(receipt.providerTerms, { free: true, noTTFA_or_DPA: true, note: FISH_AUDIO_TERMS_NOTE });
    const listing = await readdir(root);
    assert.equal(listing.filter(name => name.startsWith('.speech-fish-')).length, 0, 'temp files must be cleaned up');
    assert.equal(listing.includes('assets'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidSpeechText, inside, probeAudio, run } from './index.mjs';

const FISH_AUDIO_TTS_URL = 'https://api.fish.audio/v1/tts';
export const FISH_AUDIO_DEFAULT_MODEL = 's2.1-pro-free';
export const FISH_AUDIO_TERMS_NOTE = 'Fish Audio free tier: no TTFA/DPA guarantees; provider may use requests to improve models.';
const FISH_AUDIO_KEY_ERROR = 'FISH_AUDIO_API_KEY (or FISH_API_KEY) is required for Fish Audio speech generation. Set it in a protected local environment; never pass it as a CLI argument.';

export function resolveFishAudioOptions(env = process.env, { apiKey, model, voiceId } = {}) {
  const resolvedKey = (apiKey || env.FISH_AUDIO_API_KEY || env.FISH_API_KEY || '').trim();
  if (!resolvedKey) throw new Error(FISH_AUDIO_KEY_ERROR);
  const resolvedModel = model || env.FISH_AUDIO_MODEL || FISH_AUDIO_DEFAULT_MODEL;
  const resolvedVoiceId = (voiceId || env.FISH_AUDIO_VOICE_ID || '').trim();
  return { apiKey: resolvedKey, model: resolvedModel, voiceId: resolvedVoiceId || undefined };
}

// The narration pipeline expects probeable PCM wav, and the shared silence trim
// re-encodes to pcm_s16le, so request wav from the provider rather than mp3/opus.
export async function generateFishAudioSpeech(text, { outputPath, projectRoot, signal, timeoutMs = 120_000, apiKey, model, voiceId, speed, fetchImpl = fetch, env = process.env } = {}) {
  assertValidSpeechText(text);
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('A projectRoot and outputPath are required for isolated speech generation.');
  const root = path.resolve(projectRoot), output = path.resolve(outputPath);
  if (!inside(root, output)) throw new Error('Speech output must remain inside the project workspace.');
  await mkdir(path.dirname(output), { recursive: true });
  const realRoot = await realpath(root), realDirectory = await realpath(path.dirname(output));
  if (!inside(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error('Speech output directory escapes the project workspace.');
  const credentials = resolveFishAudioOptions(env, { apiKey, model, voiceId });
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) throw new Error('prosody speed must be a number between 0.5 and 2.');
  const requestBody = { text: text.trim(), format: 'wav', sample_rate: 44100 };
  if (credentials.voiceId) requestBody.reference_id = credentials.voiceId;
  if (speed !== undefined) requestBody.prosody = { speed };
  const runId = process.pid + '-' + Date.now();
  const rawOutput = path.join(realDirectory, '.speech-fish-source-' + runId + '.wav');
  const trimmedOutput = path.join(realDirectory, '.speech-fish-trimmed-' + runId + '.wav');
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // The model id travels in a request header, not the JSON body (Fish Audio contract).
    const response = await fetchImpl(FISH_AUDIO_TTS_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credentials.apiKey, 'Content-Type': 'application/json', model: credentials.model },
      body: JSON.stringify(requestBody),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
    if (!response.ok) {
      let message = 'request failed';
      try { const data = await response.json(); if (typeof data?.message === 'string' && data.message.trim()) message = data.message; } catch {}
      throw new Error('Fish Audio TTS API returned ' + response.status + ': ' + message);
    }
    const audioBytes = Buffer.from(await response.arrayBuffer());
    if (audioBytes.length === 0) throw new Error('Fish Audio returned no audio data.');
    await writeFile(rawOutput, audioBytes, { flag: 'wx' });
    const sourceAudio = await probeAudio(rawOutput, { signal, label: 'Fish Audio speech' });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawOutput, '-af', 'areverse,silenceremove=start_periods=1:start_duration=0.35:start_threshold=-60dB:start_silence=0.15,areverse', '-c:a', 'pcm_s16le', trimmedOutput], { cwd: realDirectory, signal, timeoutMs });
    const audio = await probeAudio(trimmedOutput, { signal, label: 'Fish Audio speech' });
    const outputStat = await stat(trimmedOutput);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('Silence-trimmed Fish Audio output is empty.');
    await rename(trimmedOutput, output);
    const digest = createHash('sha256').update(await readFile(output)).digest('hex');
    return { provider: 'fish-audio', model: credentials.model, voiceId: credentials.voiceId ?? null, speed: speed ?? null, output, sha256: digest, byteSize: outputStat.size, audio, sourceAudioDurationSeconds: sourceAudio.durationSeconds, trailingSilenceTrimmed: Math.max(0, sourceAudio.durationSeconds - audio.durationSeconds), verified: true, providerTerms: { free: true, noTTFA_or_DPA: true, note: FISH_AUDIO_TERMS_NOTE } };
  } finally {
    await Promise.all([rm(rawOutput, { force: true }), rm(trimmedOutput, { force: true })]);
  }
}

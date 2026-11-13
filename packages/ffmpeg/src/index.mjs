import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';

function assertSafePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty path.');
  if (value.includes('\0')) throw new Error(label + ' contains a null byte.');
  // Line-based consumers (e.g. the concat demuxer list file) treat a control
  // character as a directive boundary — reject them before any escaping.
  if (/[\n\r\u2028\u2029]/.test(value)) throw new Error(label + ' contains a line-break control character.');
  return path.resolve(value);
}

export function buildTranscodePlan({ input, output, width, height, fps, videoCodec = 'libx264', audioCodec = 'aac', crf = 18 } = {}) {
  const source = assertSafePath(input, 'input');
  const target = assertSafePath(output, 'output');
  if (source === target) throw new Error('Input and output paths must differ.');
  if (![width, height, fps, crf].every(Number.isFinite) || width <= 0 || height <= 0 || fps <= 0 || crf < 0 || crf > 51) throw new Error('Invalid transcode settings.');
  const args = ['-hide_banner', '-y', '-i', source, '-vf', 'scale=' + Math.round(width) + ':' + Math.round(height) + ',fps=' + fps, '-c:v', videoCodec, '-crf', String(Math.round(crf)), '-c:a', audioCodec, '-movflags', '+faststart', target];
  return { executable: 'ffmpeg', args, input: source, output: target, expected: { width: Math.round(width), height: Math.round(height), fps, videoCodec, audioCodec } };
}

export function buildProbePlan({ input } = {}) {
  const source = assertSafePath(input, 'input');
  return { executable: 'ffprobe', args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], input: source };
}

export function parseProbeOutput(text) {
  const value = JSON.parse(text);
  const video = (value.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (value.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('No video stream found.');
  return { durationSeconds: Number(value.format?.duration || video.duration || 0), width: video.width, height: video.height, frameRate: video.avg_frame_rate || video.r_frame_rate, videoCodec: video.codec_name, audioCodec: audio?.codec_name || null, hasAudio: Boolean(audio) };
}

const SAFE_VIDEO_CODECS = new Set(['libx264', 'libx265', 'prores_ks', 'libvpx-vp9']);
const SAFE_AUDIO_CODECS = new Set(['aac', 'libmp3lame', 'libopus', 'pcm_s16le']);

export function buildFinalizationPlan({ input, output, width, height, fps, durationSeconds, videoCodec = 'libx264', audioCodec = 'aac', crf = 18, audioInputs = [], subtitlePath, burnSubtitles = false, audioRequired = false } = {}) {
  const base = buildTranscodePlan({ input, output, width, height, fps, videoCodec, audioCodec, crf });
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) throw new Error('durationSeconds must be a positive finite number.');
  if (!SAFE_VIDEO_CODECS.has(videoCodec) || !SAFE_AUDIO_CODECS.has(audioCodec)) throw new Error('Codec is not in the delivery allowlist.');
  if (!Array.isArray(audioInputs)) throw new Error('audioInputs must be an array.');
  const normalizedAudio = audioInputs.map((source, index) => {
    const file = assertSafePath(source.path, 'audio input ' + index);
    const offset = Number(source.offsetSeconds || 0), volume = Number(source.volume ?? 1);
    const duration = source.durationSeconds === undefined ? null : Number(source.durationSeconds);
    const fadeIn = Number(source.fadeInSeconds || 0), fadeOut = Number(source.fadeOutSeconds || 0);
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(volume) || volume < 0 || volume > 4 || duration !== null && (!Number.isFinite(duration) || duration <= 0) || !Number.isFinite(fadeIn) || fadeIn < 0 || !Number.isFinite(fadeOut) || fadeOut < 0 || fadeOut && duration === null || duration !== null && fadeIn + fadeOut > duration) throw new Error('Invalid audio offset, gain, cue duration or fade range.');
    if (source.duckAgainstNarration !== undefined && typeof source.duckAgainstNarration !== 'boolean') throw new Error('duckAgainstNarration must be boolean.');
    return { path: file, offset, volume, duration, fadeIn, fadeOut, duckAgainstNarration: source.duckAgainstNarration === true, label: ['narration', 'music', 'sfx'].includes(source.kind) ? source.kind : 'audio' };
  });
  if (audioRequired && !normalizedAudio.length) throw new Error('This delivery requires audio, but no audio inputs were supplied.');
  const target = assertSafePath(output, 'output');
  const inputs = [assertSafePath(input, 'input')];
  const args = ['-hide_banner', '-y', '-i', inputs[0]];
  for (const source of normalizedAudio) { args.push('-i', source.path); inputs.push(source.path); }
  const filters = ['[0:v]scale=' + Math.round(width) + ':' + Math.round(height) + ':force_original_aspect_ratio=decrease,pad=' + Math.round(width) + ':' + Math.round(height) + ':(ow-iw)/2:(oh-ih)/2,fps=' + fps + '[vout]'];
  if (normalizedAudio.length) {
    normalizedAudio.forEach((a, i) => {
      const chain = ['volume=' + a.volume];
      if (a.duration !== null) chain.push('atrim=duration=' + a.duration.toFixed(6), 'asetpts=PTS-STARTPTS');
      if (a.fadeIn) chain.push('afade=t=in:st=0:d=' + a.fadeIn.toFixed(6));
      if (a.fadeOut) chain.push('afade=t=out:st=' + (a.duration - a.fadeOut).toFixed(6) + ':d=' + a.fadeOut.toFixed(6));
      const delay = Math.round(a.offset * 1000);
      chain.push('adelay=' + delay + '|' + delay);
      filters.push('[' + (i + 1) + ':a]' + chain.join(',') + '[a' + i + ']');
    });
    const narration = normalizedAudio.findIndex(a => a.label === 'narration');
    const duckedIndices = normalizedAudio.map((a, i) => a.duckAgainstNarration ? i : -1).filter(i => i >= 0);
    if (duckedIndices.length && narration < 0) throw new Error('Audio ducking requires at least one narration track.');
    if (duckedIndices.includes(narration)) throw new Error('Narration cannot be ducked against itself.');
    const sidechainLabels = new Map();
    if (duckedIndices.length) {
      const labels = duckedIndices.map((_, index) => 'narrationduck' + index);
      labels.push('narrationmix');
      filters.push('[a' + narration + ']asplit=' + labels.length + labels.map(label => '[' + label + ']').join(''));
      duckedIndices.forEach((index, duckIndex) => sidechainLabels.set(index, labels[duckIndex]));
    }
    const ducked = normalizedAudio.map((a, i) => {
      if (!a.duckAgainstNarration) return '[' + (i === narration && duckedIndices.length ? 'narrationmix' : 'a' + i) + ']';
      const out = 'duck' + i;
      filters.push('[a' + i + '][' + sidechainLabels.get(i) + ']sidechaincompress=threshold=0.035:ratio=8:attack=15:release=250:makeup=1[' + out + ']');
      return '[' + out + ']';
    });
    const audioPadding = durationSeconds === undefined ? '' : ',apad=whole_dur=' + durationSeconds.toFixed(6);
    filters.push(ducked.join('') + 'amix=inputs=' + ducked.length + ':duration=longest:normalize=0' + audioPadding + '[aout]');
  }
  if (subtitlePath) {
    const subtitles = assertSafePath(subtitlePath, 'subtitle');
    if (burnSubtitles) {
      const escaped = subtitles.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filters[0] = filters[0].replace('[vout]', '[vscaled]');
      filters.push("[vscaled]subtitles='" + escaped + "'[vout]");
    }
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (normalizedAudio.length) args.push('-map', '[aout]'); else args.push('-map', '0:a?');
  args.push('-c:v', videoCodec);
  if (videoCodec === 'prores_ks') args.push('-profile:v', '3', '-pix_fmt', 'yuv422p10le');
  else if (videoCodec === 'libvpx-vp9') args.push('-crf', String(Math.round(crf)), '-b:v', '0', '-pix_fmt', 'yuv420p');
  else args.push('-crf', String(Math.round(crf)), '-pix_fmt', 'yuv420p');
  args.push('-c:a', audioCodec);
  if (audioCodec === 'aac') args.push('-b:a', '192k');
  if (durationSeconds !== undefined) args.push('-t', Number(durationSeconds).toFixed(6));
  if (!target.toLowerCase().endsWith('.webm')) args.push('-movflags', '+faststart');
  args.push(target);
  return { executable: 'ffmpeg', args, input: inputs[0], inputs, output: target, expected: { width: Math.round(width), height: Math.round(height), fps, durationSeconds, videoCodec, audioCodec, audioRequired, hasAudio: normalizedAudio.length > 0 }, audio: normalizedAudio, subtitlePath: subtitlePath ? assertSafePath(subtitlePath, 'subtitle') : null };
}

export function runMediaCommand(executable, args, { cwd, signal, onProgress = () => {} } = {}) {
  if (!['ffmpeg', 'ffprobe'].includes(executable)) throw new Error('Only FFmpeg and FFprobe commands are permitted.');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Media command arguments must be safe strings.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; onProgress({ stream: 'stdout', text: chunk }); });
    child.stderr.on('data', chunk => { stderr += chunk; onProgress({ stream: 'stderr', text: chunk }); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ code, stdout, stderr }) : reject(new Error(executable + ' failed with exit code ' + code + '\n' + (stderr || stdout).slice(-8000))));
  });
}

export async function probeMedia(input, options = {}) {
  const plan = buildProbePlan({ input });
  const result = await runMediaCommand(plan.executable, plan.args, options);
  return parseProbeOutput(result.stdout);
}

export function inspectMedia(media, expected = {}) {
  const failures = [];
  if (!media?.width || !media?.height || !media?.videoCodec || !(media.durationSeconds > 0)) failures.push({ code: 'MEDIA_VIDEO_STREAM_INVALID', message: 'Output has no valid video stream or duration.' });
  if (expected.width && media.width !== expected.width) failures.push({ code: 'MEDIA_WIDTH_MISMATCH', expected: expected.width, actual: media.width });
  if (expected.height && media.height !== expected.height) failures.push({ code: 'MEDIA_HEIGHT_MISMATCH', expected: expected.height, actual: media.height });
  if (expected.fps) { const [n, d = '1'] = String(media.frameRate).split('/'); if (!Number.isFinite(Number(n) / Number(d)) || Math.abs(Number(n) / Number(d) - expected.fps) >= 0.001) failures.push({ code: 'MEDIA_FRAME_RATE_MISMATCH', expected: expected.fps, actual: media.frameRate }); }
  if (expected.audioRequired && !media.hasAudio) failures.push({ code: 'MEDIA_AUDIO_MISSING', message: 'Delivery contract requires an audio stream.' });
  if (expected.durationSeconds && Math.abs(media.durationSeconds - expected.durationSeconds) > (expected.durationToleranceSeconds ?? 0.05)) failures.push({ code: 'MEDIA_DURATION_MISMATCH', expected: expected.durationSeconds, actual: media.durationSeconds });
  return { passed: failures.length === 0, failures, media };
}

export async function finalizeMedia(options = {}) {
  const plan = buildFinalizationPlan(options);
  await access(plan.input);
  for (const input of plan.inputs.slice(1)) await access(input);
  if (plan.subtitlePath) await access(plan.subtitlePath);
  await mkdir(path.dirname(plan.output), { recursive: true });
  await runMediaCommand(plan.executable, plan.args, options);
  const outputStat = await stat(plan.output);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error('FFmpeg returned without a non-empty output file.');
  const media = await probeMedia(plan.output, options);
  const result = inspectMedia(media, { width: plan.expected.width, height: plan.expected.height, fps: plan.expected.fps, durationSeconds: plan.expected.durationSeconds, durationToleranceSeconds: 1 / plan.expected.fps + 0.02, audioRequired: plan.expected.audioRequired });
  const receipt = { output: plan.output, bytes: outputStat.size, verified: result.passed, media: result.media, checks: result, createdAt: new Date().toISOString(), input: plan.input, audio: plan.audio, subtitlePath: plan.subtitlePath };
  if (!result.passed) throw Object.assign(new Error('Final media failed independent FFprobe inspection.'), { receipt });
  return receipt;
}

// Assembly-time audio cues (P3.3): narration/SFX mixed into the assembled
// master. Frame-agnostic by contract — offsets/durations/fades arrive in
// seconds, computed by the caller. Same fail-closed normalization rules as
// finalizeMedia, plus an optional `duckAgainst` path that must reference
// another input in the same list (sidechaincompress source). Idempotent: the
// normalized output is itself valid input, so callers may pre-normalize (e.g.
// render-manager fail-fast validation) and pass the result on.
export function normalizeAssemblyAudioInputs(audioInputs) {
  if (audioInputs === undefined) return [];
  if (!Array.isArray(audioInputs)) throw new Error('audioInputs must be an array of { path, offsetSeconds, ... } audio cues.');
  const normalized = audioInputs.map((source, index) => {
    if (!source || typeof source !== 'object') throw new Error('audioInputs[' + index + '] must be an object with a path.');
    const file = assertSafePath(source.path, 'audioInputs[' + index + '].path');
    const offset = Number(source.offsetSeconds || 0), volume = Number(source.volume ?? 1);
    const duration = source.durationSeconds === undefined ? null : Number(source.durationSeconds);
    const fadeIn = Number(source.fadeInSeconds || 0), fadeOut = Number(source.fadeOutSeconds || 0);
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(volume) || volume < 0 || volume > 4 || duration !== null && (!Number.isFinite(duration) || duration <= 0) || !Number.isFinite(fadeIn) || fadeIn < 0 || !Number.isFinite(fadeOut) || fadeOut < 0 || fadeOut && duration === null || duration !== null && fadeIn + fadeOut > duration) throw new Error('Invalid audio offset, gain, cue duration or fade range for audioInputs[' + index + '].');
    if (source.duckAgainst !== undefined && source.duckAgainst !== null && (typeof source.duckAgainst !== 'string' || !source.duckAgainst.trim())) throw new Error('audioInputs[' + index + '].duckAgainst must be the path of another audio input when provided.');
    const duckAgainst = source.duckAgainst === undefined || source.duckAgainst === null ? null : assertSafePath(source.duckAgainst, 'audioInputs[' + index + '].duckAgainst');
    return {
      path: file, offsetSeconds: offset, volume,
      ...(duration !== null ? { durationSeconds: duration } : {}),
      fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut,
      ...(duckAgainst !== null ? { duckAgainst } : {})
    };
  });
  const byPath = new Map(normalized.map(cue => [cue.path, cue]));
  for (const [index, cue] of normalized.entries()) {
    if (cue.duckAgainst === undefined) continue;
    const target = byPath.get(cue.duckAgainst);
    if (!target) throw new Error('audioInputs[' + index + '].duckAgainst must reference another audio input path; no audio input resolves to ' + cue.duckAgainst + '.');
    if (target === cue) throw new Error('audioInputs[' + index + '] cannot duck against itself.');
  }
  return normalized;
}

// Mixing graph for assembly audio: per-cue volume/trim/fade chains ending in an
// adelay offset, then one amix padded/trimmed to the concat timeline length.
// Ducking mirrors finalizeMedia: each duck-against target is split so one copy
// feeds the sidechain of every input that ducks against it and one copy
// reaches the final mix.
function buildAssemblyAudioMixGraph(audioInputs, totalSeconds) {
  const filters = [];
  audioInputs.forEach((cue, index) => {
    const duration = cue.durationSeconds === undefined ? null : cue.durationSeconds;
    const chain = ['volume=' + cue.volume];
    if (duration !== null) chain.push('atrim=duration=' + duration.toFixed(6), 'asetpts=PTS-STARTPTS');
    if (cue.fadeInSeconds) chain.push('afade=t=in:st=0:d=' + cue.fadeInSeconds.toFixed(6));
    if (cue.fadeOutSeconds) chain.push('afade=t=out:st=' + (duration - cue.fadeOutSeconds).toFixed(6) + ':d=' + cue.fadeOutSeconds.toFixed(6));
    const delay = Math.round(cue.offsetSeconds * 1000);
    chain.push('adelay=' + delay + '|' + delay);
    filters.push('[' + (index + 1) + ':a]' + chain.join(',') + '[a' + index + ']');
  });
  const targetByDucked = new Map(), duckersByTarget = new Map();
  for (const [index, cue] of audioInputs.entries()) {
    if (cue.duckAgainst === undefined) continue;
    const targetIndex = audioInputs.findIndex(item => item.path === cue.duckAgainst);
    targetByDucked.set(index, targetIndex);
    if (!duckersByTarget.has(targetIndex)) duckersByTarget.set(targetIndex, []);
    duckersByTarget.get(targetIndex).push(index);
  }
  const sidechainLabelByDucked = new Map();
  for (const [targetIndex, duckedIndices] of duckersByTarget) {
    const labels = duckedIndices.map((_, position) => 'sidechain' + targetIndex + 'x' + position);
    labels.push('targetmix' + targetIndex);
    filters.push('[a' + targetIndex + ']asplit=' + labels.length + labels.map(label => '[' + label + ']').join(''));
    duckedIndices.forEach((duckedIndex, position) => sidechainLabelByDucked.set(duckedIndex, labels[position]));
  }
  for (const [duckedIndex] of targetByDucked) {
    filters.push('[a' + duckedIndex + '][' + sidechainLabelByDucked.get(duckedIndex) + ']sidechaincompress=threshold=0.035:ratio=8:attack=15:release=250:makeup=1[duck' + duckedIndex + ']');
  }
  const mixInputs = audioInputs.map((_, index) => targetByDucked.has(index) ? '[duck' + index + ']' : duckersByTarget.has(index) ? '[targetmix' + index + ']' : '[a' + index + ']');
  filters.push(mixInputs.join('') + 'amix=inputs=' + audioInputs.length + ':duration=longest:normalize=0,apad=whole_dur=' + totalSeconds.toFixed(6) + '[aout]');
  return filters.join(';');
}

// Scene assembly (v2 master refresh path): concat per-scene MP4 segments in
// exact IR scene order through the FFmpeg concat demuxer with a deterministic
// re-encode. Every segment is probed before encoding and the assembled master
// is probed afterwards; any mismatch fails closed with a receipt attached.
// With audioInputs the cues are mixed into the concat output (aac); without
// them the args stay exactly the video-only contract (-an).
export function buildSceneAssemblyPlan({ sceneFiles, fps, output, videoCodec = 'libx264', crf = 18, width, height, audioInputs } = {}) {
  if (!Array.isArray(sceneFiles) || !sceneFiles.length) throw new Error('Scene assembly requires a non-empty sceneFiles array.');
  const numerator = Number(fps?.numerator), denominator = Number(fps?.denominator);
  if (!Number.isInteger(numerator) || numerator <= 0 || !Number.isInteger(denominator) || denominator <= 0) throw new Error('Scene assembly requires a positive integer rational fps.');
  if (!SAFE_VIDEO_CODECS.has(videoCodec)) throw new Error('Video codec is not in the delivery allowlist.');
  if (!Number.isFinite(crf) || crf < 0 || crf > 51) throw new Error('Invalid crf.');
  const target = assertSafePath(output, 'output');
  const segments = sceneFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('sceneFiles[' + index + '] must be an object with path and durationFrames.');
    const segmentPath = assertSafePath(entry.path, 'sceneFiles[' + index + '].path');
    if (!Number.isInteger(entry.durationFrames) || entry.durationFrames <= 0) throw new Error('sceneFiles[' + index + '].durationFrames must be a positive integer.');
    return { path: segmentPath, durationFrames: entry.durationFrames };
  });
  let expectedWidth = null, expectedHeight = null;
  if (width !== undefined || height !== undefined) {
    expectedWidth = Number(width); expectedHeight = Number(height);
    if (!Number.isInteger(expectedWidth) || expectedWidth <= 0 || !Number.isInteger(expectedHeight) || expectedHeight <= 0) throw new Error('Scene assembly target dimensions must be positive integers when provided.');
  }
  const fpsArgument = denominator === 1 ? String(numerator) : numerator + '/' + denominator;
  const listPath = path.join(path.dirname(target), path.basename(target) + '.concat-list.txt');
  // Concat demuxer list entries: absolute paths, quoted, with ffmpeg's single-
  // quote escaping; forward slashes keep Windows paths parseable.
  const listEntries = segments.map(segment => "file '" + segment.path.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
  const audio = normalizeAssemblyAudioInputs(audioInputs);
  const frameCount = segments.reduce((sum, segment) => sum + segment.durationFrames, 0);
  const totalSeconds = frameCount * denominator / numerator;
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath];
  for (const cue of audio) args.push('-i', cue.path);
  if (audio.length) args.push('-map', '0:v', '-filter_complex', buildAssemblyAudioMixGraph(audio, totalSeconds), '-map', '[aout]');
  args.push('-c:v', videoCodec);
  if (videoCodec === 'prores_ks') args.push('-profile:v', '3', '-pix_fmt', 'yuv422p10le');
  else if (videoCodec === 'libvpx-vp9') args.push('-crf', String(Math.round(crf)), '-b:v', '0', '-pix_fmt', 'yuv420p');
  else args.push('-crf', String(Math.round(crf)), '-pix_fmt', 'yuv420p');
  // Re-encode at the exact rational fps. Audio is dropped (-an) unless cues
  // were supplied; then the mix is encoded as aac and hard-trimmed to the
  // concat timeline so the master duration stays frame-authoritative.
  args.push('-r', fpsArgument);
  if (audio.length) args.push('-c:a', 'aac', '-b:a', '192k', '-t', totalSeconds.toFixed(6));
  else args.push('-an');
  if (!target.toLowerCase().endsWith('.webm')) args.push('-movflags', '+faststart');
  args.push(target);
  return { executable: 'ffmpeg', args, listPath, listEntries, output: target, sceneFiles: segments, fps: { numerator, denominator }, fpsArgument, audioInputs: audio, expected: { width: expectedWidth, height: expectedHeight, fps: numerator / denominator, frameCount, videoCodec, crf: Math.round(crf), hasAudio: audio.length > 0 } };
}

export async function countVideoFrames(input, options = {}) {
  const source = assertSafePath(input, 'input');
  const result = await runMediaCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', source], options);
  const count = Number(JSON.parse(result.stdout).streams?.[0]?.nb_read_frames);
  if (!Number.isInteger(count) || count < 0) throw new Error('FFprobe could not count decoded video frames for ' + source + '.');
  return count;
}

function rationalFrameRateValue(frameRate) {
  const [n, d = '1'] = String(frameRate).split('/');
  const value = Number(n) / Number(d);
  return Number.isFinite(value) ? value : NaN;
}

export async function assembleScenes(options = {}) {
  const plan = buildSceneAssemblyPlan(options);
  const fpsValue = plan.expected.fps;
  // One frame of container-rounding slack, matching render-manager's
  // durationWithinOneFrame convention.
  const frameTolerance = 1 / fpsValue + 0.02;
  const timeoutMs = options.timeoutMs === undefined ? null : Number(options.timeoutMs);
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('timeoutMs must be a positive number when provided.');
  const timeoutController = timeoutMs !== null ? new AbortController() : null;
  const signals = [options.signal, timeoutController?.signal].filter(Boolean);
  const commandSignal = signals.length ? AbortSignal.any(signals) : undefined;
  const timer = timeoutController ? setTimeout(() => timeoutController.abort(), timeoutMs) : null;
  try {
    // Fail closed before encoding: every segment must exist and match the
    // target dimensions, frame rate and declared frame duration.
    const segments = [];
    let targetWidth = plan.expected.width, targetHeight = plan.expected.height;
    for (const [index, segment] of plan.sceneFiles.entries()) {
      try { await access(segment.path); }
      catch { throw new Error('Scene segment file is missing: ' + segment.path); }
      const media = await probeMedia(segment.path, { signal: commandSignal });
      if (targetWidth === null) { targetWidth = media.width; targetHeight = media.height; }
      const mismatches = [];
      if (media.width !== targetWidth || media.height !== targetHeight) mismatches.push({ code: 'SCENE_DIMENSION_MISMATCH', expected: { width: targetWidth, height: targetHeight }, actual: { width: media.width, height: media.height } });
      if (Math.abs(rationalFrameRateValue(media.frameRate) - fpsValue) >= 0.001) mismatches.push({ code: 'SCENE_FRAME_RATE_MISMATCH', expected: fpsValue, actual: media.frameRate });
      const expectedSeconds = segment.durationFrames / fpsValue;
      if (Math.abs(media.durationSeconds - expectedSeconds) > frameTolerance) mismatches.push({ code: 'SCENE_DURATION_MISMATCH', expectedFrames: segment.durationFrames, expectedSeconds, actualSeconds: media.durationSeconds });
      if (mismatches.length) throw Object.assign(new Error('Scene segment ' + index + ' failed pre-assembly verification: ' + mismatches.map(item => item.code).join(', ') + ' (' + segment.path + ')'), { mismatches, segmentPath: segment.path });
      segments.push({ path: segment.path, durationFrames: segment.durationFrames, durationSeconds: media.durationSeconds, width: media.width, height: media.height, frameRate: media.frameRate });
    }
    // Same fail-closed rule for assembly audio: every cue file must exist
    // before the encode starts.
    for (const cue of plan.audioInputs) {
      try { await access(cue.path); }
      catch { throw new Error('Audio input file is missing: ' + cue.path); }
    }
    await mkdir(path.dirname(plan.output), { recursive: true });
    await writeFile(plan.listPath, plan.listEntries.join('\n') + '\n', 'utf8');
    try { await runMediaCommand(plan.executable, plan.args, { signal: commandSignal, onProgress: options.onLine }); }
    catch (error) {
      if (timeoutController?.signal.aborted) throw new Error('Scene assembly timed out after ' + timeoutMs + 'ms.');
      throw error;
    }
    const outputStat = await stat(plan.output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('FFmpeg returned without a non-empty assembled master at ' + plan.output);
    const media = await probeMedia(plan.output, { signal: commandSignal });
    const frameCount = await countVideoFrames(plan.output, { signal: commandSignal });
    const expectedAudioSeconds = plan.expected.hasAudio ? plan.expected.frameCount / fpsValue : null;
    const checks = {
      widthMatches: media.width === targetWidth,
      heightMatches: media.height === targetHeight,
      frameRateMatch: Math.abs(rationalFrameRateValue(media.frameRate) - fpsValue) < 0.001,
      frameCountMatchesTimeline: frameCount === plan.expected.frameCount,
      audioStreamPresent: !plan.expected.hasAudio || (media.hasAudio === true && media.audioCodec === 'aac'),
      audioDurationMatchesTimeline: !plan.expected.hasAudio || Math.abs(media.durationSeconds - expectedAudioSeconds) <= frameTolerance,
      nonEmpty: outputStat.size > 0
    };
    const receipt = {
      output: plan.output, bytes: outputStat.size, verified: Object.values(checks).every(Boolean),
      checks, media, frameCount, expectedFrameCount: plan.expected.frameCount,
      sceneCount: plan.sceneFiles.length, totalDurationFrames: plan.expected.frameCount,
      fps: fpsValue, fpsRational: plan.fpsArgument, videoCodec: plan.expected.videoCodec,
      audio: plan.expected.hasAudio ? 'aac' : 'none', audioInputs: plan.audioInputs,
      listPath: plan.listPath, segments, createdAt: new Date().toISOString()
    };
    if (!receipt.verified) throw Object.assign(new Error('Assembled master failed independent FFprobe verification: ' + Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')), { receipt });
    return receipt;
  } finally { if (timer) clearTimeout(timer); }
}

function timestamp(seconds, decimalSeparator) {
  const millis = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(millis / 3600000), m = Math.floor(millis % 3600000 / 60000), s = Math.floor(millis % 60000 / 1000), ms = millis % 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + decimalSeparator + String(ms).padStart(3, '0');
}

export function renderCaptions(cues, frameRate, format = 'srt') {
  validateCaptionTimeline(cues, frameRate);
  const fps = frameRate.numerator / frameRate.denominator;
  const ordered = [...cues].sort((a, b) => a.startFrame - b.startFrame);
  const sep = format === 'srt' ? ',' : '.';
  const blocks = ordered.map((cue, index) => {
    const start = timestamp(cue.startFrame / fps, sep), end = timestamp(cue.endFrame / fps, sep);
    return (format === 'srt' ? String(index + 1) + '\n' + start + ' --> ' + end + '\n' + cue.text.trim() : start + ' --> ' + end + '\n' + cue.text.trim());
  });
  if (format === 'vtt') return 'WEBVTT\n\n' + blocks.join('\n\n') + (blocks.length ? '\n' : '');
  if (format !== 'srt') throw new Error('Caption format must be srt or vtt.');
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

export function validateCaptionTimeline(cues, frameRate, totalDurationFrames) {
  if (!Array.isArray(cues) || !Number.isInteger(frameRate?.numerator) || !Number.isInteger(frameRate?.denominator) || frameRate.numerator <= 0 || frameRate.denominator <= 0) throw new Error('Caption cues and rational frameRate are required.');
  if (totalDurationFrames !== undefined && (!Number.isInteger(totalDurationFrames) || totalDurationFrames <= 0)) throw new Error('Caption validation requires a positive integer project duration in frames.');
  const ordered = [...cues].sort((a, b) => a.startFrame - b.startFrame);
  let previousStart = -1;
  const fps = frameRate.numerator / frameRate.denominator;
  for (const [index, cue] of ordered.entries()) {
    if (!Number.isInteger(cue.startFrame) || !Number.isInteger(cue.endFrame) || cue.startFrame < 0 || cue.endFrame <= cue.startFrame || typeof cue.text !== 'string' || !cue.text.trim()) throw new Error('Caption ' + (index + 1) + ' requires non-empty text and a valid integer frame range.');
    if (cue.startFrame < previousStart) throw new Error('Caption cues must be ordered monotonically by start frame.');
    if (totalDurationFrames !== undefined && cue.endFrame > totalDurationFrames) throw new Error('Caption ' + (index + 1) + ' extends beyond the project duration.');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(cue.text)) throw new Error('Caption ' + (index + 1) + ' contains invalid UTF-8 text or unsupported control characters.');
    for (const frame of [cue.startFrame, cue.endFrame]) {
      const milliseconds = Math.round(frame / fps * 1000);
      const roundTripFrame = Math.round(milliseconds / 1000 * fps);
      if (Math.abs(roundTripFrame - frame) > 0.5) throw new Error('Caption ' + (index + 1) + ' timing cannot be represented at millisecond caption precision.');
    }
    previousStart = cue.startFrame;
  }
  return { valid: true, cueCount: ordered.length, frameRate: { ...frameRate }, totalDurationFrames: totalDurationFrames ?? null, timingPrecision: 'milliseconds' };
}

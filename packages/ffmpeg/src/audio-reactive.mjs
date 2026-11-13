// P3.3 audio-reactive analysis: deterministic, frame-bound audio envelope.
//
// Contract: one RMS window per `windowFrames` video frames, derived from the
// audio stream itself (never wall-clock), so the same input always yields the
// identical envelope JSON. Silence (-Inf dB) is clamped/flagged to a -60 dB
// floor marker. Window boundaries are integer frame ranges in the caller's
// fps, matching the Canonical Video IR frame-time conventions.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMediaCommand } from './index.mjs';

// -Inf dB (digital silence) is clamped to this floor marker so envelope JSON
// stays finite and chartable; genuine levels below it pass through untouched.
export const SILENCE_FLOOR_DB = -60;
// Frame-count rounding slack: container durations land within this of the
// integer frame count at the analysis fps.
const FRAME_EPSILON = 1e-4;

// Mirrors assertSafePath in index.mjs (kept private there; duplicated here to
// honor the single re-export line constraint for this module).
function assertSafePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty path.');
  if (value.includes('\0')) throw new Error(label + ' contains a null byte.');
  // Line-based consumers (here: the lavfi filtergraph string) treat a control
  // character as a directive boundary — reject them before any escaping.
  if (/[\n\r\u2028\u2029]/.test(value)) throw new Error(label + ' contains a line-break control character.');
  return path.resolve(value);
}

// ffmpeg filtergraph quoted-filename escaping for amovie: backslashes become
// forward slashes, the Windows drive colon is escaped, and the value is
// wrapped in single quotes (same convention as the subtitles filter in
// buildFinalizationPlan). Literal single quotes cannot round-trip through the
// filtergraph tokenizer (verified empirically on ffmpeg 9.0.2: every quote
// variant breaks option parsing), so analyzeAudioEnvelope routes such paths
// through a byte-identical temp copy instead of embedding them raw.
export function escapeAmovieFilename(filePath) {
  if (filePath.includes("'")) throw new Error('Audio path contains a single quote, which ffmpeg filtergraph filenames cannot represent; it must be re-encoded via a safe temp copy: ' + filePath);
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function analysisFpsValue(fps) {
  if (fps && Number.isInteger(fps.numerator) && Number.isInteger(fps.denominator) && fps.numerator > 0 && fps.denominator > 0) {
    return fps.numerator / fps.denominator;
  }
  const value = Number(fps);
  if (!Number.isFinite(value) || value <= 0) throw new Error('fps must be a positive finite number or a {numerator, denominator} rational.');
  return value;
}

function durationFramesFromSeconds(durationSeconds, fps) {
  const exact = durationSeconds * fps;
  const rounded = Math.round(exact);
  // Tolerate container rounding to the nearest frame, otherwise round up so
  // the windows cover every partial frame of the audio stream.
  return Math.abs(exact - rounded) < FRAME_EPSILON ? rounded : Math.ceil(exact);
}

// Pure plan builder (mirrors buildProbePlan): lets tests verify the filtergraph
// escaping without spawning ffprobe.
export function buildAudioEnvelopeProbePlan({ audioPath, fps, windowFrames = 1, sampleRate, durationSeconds } = {}) {
  const source = assertSafePath(audioPath, 'audioPath');
  const rate = analysisFpsValue(fps);
  if (!Number.isInteger(windowFrames) || windowFrames <= 0) throw new Error('windowFrames must be a positive integer.');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('sampleRate must be a positive integer (from the audio stream probe).');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('durationSeconds must be a positive finite number (from the audio stream probe).');
  const durationFrames = durationFramesFromSeconds(durationSeconds, rate);
  // One astats window per windowFrames video frames: asetnsamples pins the
  // audio frame size to exactly one video frame of samples, then astats
  // reset=windowFrames groups those audio frames into the output windows.
  const samplesPerFrame = Math.max(1, Math.round(sampleRate / rate));
  const filter = "amovie='" + escapeAmovieFilename(source) + "',asetnsamples=n=" + samplesPerFrame + ':p=0,astats=metadata=1:reset=' + windowFrames;
  return {
    executable: 'ffprobe',
    args: ['-v', 'error', '-f', 'lavfi', '-i', filter, '-show_entries', 'frame_tags=lavfi.astats.Overall.RMS_level', '-of', 'csv=p=0'],
    input: source, filter, fps: rate, windowFrames, samplesPerFrame, sampleRate, durationFrames,
    expectedWindows: Math.ceil(durationFrames / windowFrames)
  };
}

function parseRmsLine(line) {
  if (line === '-inf' || line === '-Infinity') return SILENCE_FLOOR_DB;
  if (line === 'inf' || line === '+inf' || line === 'Infinity') return 0;
  const value = Number(line);
  if (!Number.isFinite(value)) throw new Error('ffprobe produced an unparseable RMS level: ' + line);
  // Three decimals keep the JSON compact and stable across repeated runs.
  return Number(value.toFixed(3));
}

export async function analyzeAudioEnvelope({ audioPath, fps, windowFrames = 1, signal, onProgress = () => {} } = {}) {
  const source = assertSafePath(audioPath, 'audioPath');
  const rate = analysisFpsValue(fps);
  if (!Number.isInteger(windowFrames) || windowFrames <= 0) throw new Error('windowFrames must be a positive integer.');
  const probe = await runMediaCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,duration', '-show_entries', 'format=duration', '-of', 'json', source], { signal, onProgress });
  const probeJson = JSON.parse(probe.stdout);
  const stream = (probeJson.streams || [])[0];
  const sampleRate = Number(stream?.sample_rate);
  const durationSeconds = Number(stream?.duration ?? probeJson.format?.duration);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('No audio stream with a positive integer sample_rate found: ' + source);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('No audio duration found: ' + source);
  // A literal single quote in the path breaks the filtergraph tokenizer, so the
  // analysis runs against a byte-identical copy under a generated safe name;
  // RMS values (and therefore the envelope JSON) are unchanged by the copy.
  let analysisPath = source, tempDir = null;
  if (source.includes("'")) {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'motion-audio-envelope-'));
    const safeName = 'envelope-' + createHash('sha256').update(source.toLowerCase()).digest('hex').slice(0, 16) + (path.extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.audio');
    analysisPath = path.join(tempDir, safeName);
    await copyFile(source, analysisPath);
  }
  try {
    const plan = buildAudioEnvelopeProbePlan({ audioPath: analysisPath, fps: rate, windowFrames, sampleRate, durationSeconds });
    const result = await runMediaCommand(plan.executable, plan.args, { signal, onProgress });
    const measured = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseRmsLine);
    const windows = [];
    const warnings = [];
    if (measured.length > plan.expectedWindows) {
      warnings.push({ code: 'ENVELOPE_WINDOWS_TRUNCATED', message: 'ffprobe returned more windows than the audio duration implies; truncated to the declared duration.', measured: measured.length, expected: plan.expectedWindows });
    }
    const total = Math.min(measured.length, plan.expectedWindows);
    for (let index = 0; index < total; index += 1) {
      windows.push({ startFrame: index * windowFrames, endFrame: Math.min(plan.durationFrames, (index + 1) * windowFrames), rmsDb: measured[index] });
    }
    if (windows.length < plan.expectedWindows) {
      warnings.push({ code: 'ENVELOPE_WINDOWS_PADDED', message: 'Audio stream ended before the declared duration; trailing windows repeat the last measured RMS level.', measured: measured.length, expected: plan.expectedWindows });
      while (windows.length < plan.expectedWindows) {
        const startFrame = windows.length * windowFrames;
        windows.push({ startFrame, endFrame: Math.min(plan.durationFrames, startFrame + windowFrames), rmsDb: windows.length ? windows[windows.length - 1].rmsDb : SILENCE_FLOOR_DB });
      }
    }
    const envelope = { fps: rate, windowFrames, durationFrames: plan.durationFrames, windows };
    return warnings.length ? { ...envelope, warnings } : envelope;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export function validateAudioEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Envelope must be an object with fps, windowFrames and windows.');
  if (!(Number(envelope.fps) > 0) || !Number.isFinite(Number(envelope.fps))) throw new Error('Envelope fps must be a positive finite number.');
  if (!Number.isInteger(envelope.windowFrames) || envelope.windowFrames <= 0) throw new Error('Envelope windowFrames must be a positive integer.');
  if (!Array.isArray(envelope.windows) || envelope.windows.length === 0) throw new Error('Envelope must contain at least one window.');
  envelope.windows.forEach((window, index) => {
    if (!window || typeof window !== 'object') throw new Error('Envelope window ' + index + ' must be an object.');
    if (!Number.isInteger(window.startFrame) || window.startFrame < 0 || !Number.isInteger(window.endFrame) || window.endFrame <= window.startFrame) throw new Error('Envelope window ' + index + ' needs a valid integer startFrame < endFrame.');
    if (!Number.isFinite(Number(window.rmsDb))) throw new Error('Envelope window ' + index + ' needs a finite rmsDb value.');
  });
  return true;
}

// Chart consumption: one normalized 0..1 value per window, clamped to
// [floorDb, ceilDb] and rounded to four decimals so repeated compiles are
// byte-identical. Labels carry the window start frame for timeline read-back.
export function envelopeToChartData(envelope, { floorDb = SILENCE_FLOOR_DB, ceilDb = 0 } = {}) {
  validateAudioEnvelope(envelope);
  if (!Number.isFinite(Number(floorDb)) || !Number.isFinite(Number(ceilDb)) || Number(ceilDb) <= Number(floorDb)) throw new Error('ceilDb must be a finite value greater than floorDb.');
  const floor = Number(floorDb), ceiling = Number(ceilDb);
  return envelope.windows.map(window => {
    const normalized = (Number(window.rmsDb) - floor) / (ceiling - floor);
    return { label: String(window.startFrame), value: Number(Math.min(1, Math.max(0, normalized)).toFixed(4)) };
  });
}

// Deterministic peak-preserving reduction for charts that cap the number of
// bars (renderChartSvg accepts at most 100 points): windows are grouped into
// contiguous buckets and the loudest window of each bucket represents it.
// Envelopes already within the cap are returned unchanged.
export function downsampleEnvelope(envelope, maxWindows = 100) {
  validateAudioEnvelope(envelope);
  if (!Number.isInteger(maxWindows) || maxWindows < 1) throw new Error('maxWindows must be a positive integer.');
  const windows = envelope.windows;
  if (windows.length <= maxWindows) return envelope;
  const downsampled = [];
  for (let bucket = 0; bucket < maxWindows; bucket += 1) {
    const start = Math.floor(bucket * windows.length / maxWindows);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * windows.length / maxWindows));
    let peak = windows[start];
    for (let index = start + 1; index < end; index += 1) if (windows[index].rmsDb > peak.rmsDb) peak = windows[index];
    downsampled.push(peak);
  }
  return { ...envelope, windows: downsampled };
}

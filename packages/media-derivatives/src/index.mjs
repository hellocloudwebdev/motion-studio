import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff'
};
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

function run(executable, args, { timeoutMs = 120000, maxOutputBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(executable + ' timed out after ' + timeoutMs + 'ms.'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > maxOutputBytes) {
        child.kill();
        finish(new Error(executable + ' exceeded its stdout limit.'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 256_000) {
        child.kill();
        finish(new Error(executable + ' exceeded its stderr limit.'));
      }
    });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) finish(new Error(executable + ' exited with code ' + code + ': ' + stderr.slice(-2000)));
      else finish(null, { stdout, stderr });
    });
  });
}

async function sha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function assertPathHasNoSymlinks(target, expectedKind, message) {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let finalInfo;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(message);
    finalInfo = info;
  }
  if (!finalInfo || (expectedKind === 'file' && !finalInfo.isFile()) || (expectedKind === 'directory' && !finalInfo.isDirectory())) throw new Error(message);
  return finalInfo;
}

async function assertRegularSource(source) {
  return assertPathHasNoSymlinks(source, 'file', 'Media source must be a regular, non-symlink file reached without symlinked path components.');
}

function validateOptions(options) {
  const profile = options.profile ?? 'all';
  if (!['all', 'proxy', 'preview'].includes(profile)) throw new Error('profile must be all, proxy or preview.');
  const thumbnailAtSeconds = options.thumbnailAtSeconds ?? 1;
  if (!Number.isFinite(thumbnailAtSeconds) || thumbnailAtSeconds < 0 || thumbnailAtSeconds > 86400) {
    throw new Error('thumbnailAtSeconds must be between 0 and 86400.');
  }
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be between 1000 and 600000.');
  return { profile, thumbnailAtSeconds, timeoutMs, overwrite: options.overwrite === true };
}

/**
 * Create reproducible local previews from one video, audio or raster-image source.
 * Source files are never modified. FFmpeg/FFprobe are invoked without a shell.
 */
export async function generateMediaDerivatives(sourcePath, outputDirectory, options = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('sourcePath is required.');
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) throw new Error('outputDirectory is required.');
  const settings = validateOptions(options);
  const source = path.resolve(sourcePath);
  const outputRoot = path.resolve(outputDirectory);
  const sourceInfo = await assertRegularSource(source);
  await mkdir(outputRoot, { recursive: true });
  await assertPathHasNoSymlinks(outputRoot, 'directory', 'Output directory must be reached without symlinked path components.');
  const realOutputRoot = path.resolve(outputRoot);
  const ext = path.extname(source).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) throw new Error('Unsupported media type for derivatives: ' + (ext || '(no extension)'));
  const sourceHash = await sha256(source);
  const stem = path.basename(source, ext).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'asset';
  const prefix = stem + '-' + sourceHash.slice(0, 12);
  const ffmpeg = options.ffmpegPath || 'ffmpeg';
  const ffprobe = options.ffprobePath || 'ffprobe';
  const probeResult = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], { timeoutMs: settings.timeoutMs });
  let probe;
  try { probe = JSON.parse(probeResult.stdout); } catch { throw new Error('FFprobe returned invalid JSON.'); }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const isImage = mimeType.startsWith('image/');
  const hasVideo = !isImage && streams.some(stream => stream.codec_type === 'video');
  const hasAudio = streams.some(stream => stream.codec_type === 'audio');
  if (!hasVideo && !hasAudio && !isImage) throw new Error('No supported video, audio or raster-image stream was found.');
  const duration = Number(probe.format?.duration);
  const seek = Number.isFinite(duration) && duration > 0
    ? Math.min(settings.thumbnailAtSeconds, Math.max(0, duration / 2))
    : settings.thumbnailAtSeconds;
  const outputs = [];
  const makeOutput = async (kind, extension, args, type) => {
    const target = path.resolve(realOutputRoot, prefix + '.' + kind + extension);
    if (!within(realOutputRoot, target) || target === realOutputRoot) throw new Error('Derivative output escaped output directory.');
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Refusing to overwrite a non-regular derivative target: ' + target);
      if (!settings.overwrite) throw new Error('Derivative already exists (pass overwrite=true to replace): ' + target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const writeArgs = [...args, settings.overwrite ? '-y' : '-n', target];
    try {
      await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...writeArgs], { timeoutMs: settings.timeoutMs });
      const info = await stat(target);
      if (!info.isFile() || info.size === 0) throw new Error('FFmpeg produced an empty or invalid derivative: ' + target);
      outputs.push({ kind, path: target, mimeType: type, byteSize: info.size, sha256: await sha256(target) });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  };

  if (hasVideo && settings.profile !== 'preview') {
    await makeOutput('proxy', '.mp4', [
      '-i', source, '-map', '0:v:0', '-map', '0:a?', '-vf', "scale=w='min(1280,iw)':h=-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart'
    ], 'video/mp4');
  }
  if (hasVideo && settings.profile !== 'proxy') {
    await makeOutput('thumbnail', '.jpg', [
      '-ss', String(seek), '-i', source, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=w=640:h=-2:force_original_aspect_ratio=decrease', '-q:v', '3'
    ], 'image/jpeg');
  }
  if (hasAudio && !hasVideo && settings.profile !== 'proxy') {
    await makeOutput('waveform', '.png', [
      '-i', source, '-filter_complex', 'showwavespic=s=1600x240:colors=white',
      '-frames:v', '1'
    ], 'image/png');
  }
  if (isImage && settings.profile !== 'proxy') {
    await makeOutput('preview', '.jpg', [
      '-i', source, '-frames:v', '1',
      '-vf', 'scale=w=1600:h=1600:force_original_aspect_ratio=decrease', '-q:v', '3'
    ], 'image/jpeg');
  }
  if (outputs.length === 0) throw new Error('No derivative was generated for this source/profile combination.');
  return {
    derivativeVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: { path: source, mimeType, byteSize: sourceInfo.size, sha256: sourceHash },
    profile: settings.profile,
    outputs
  };
}

const SAFE_MEDIA_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_FRAME_INDEX = 10_000_000;
const MAX_FRAME_RATE = 10_000;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const CONTAINER_FASTSTART_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
// Trims re-encode to the same codec family so the output stays interchangeable
// with the source; entries map probed codec_name to a fixed encoder + rate control.
const SAME_FAMILY_ENCODERS = {
  h264: { encoder: 'libx264', rateControl: ['-crf', '18'] },
  hevc: { encoder: 'libx265', rateControl: ['-crf', '18'] },
  mpeg4: { encoder: 'mpeg4', rateControl: ['-q:v', '4'] },
  vp9: { encoder: 'libvpx-vp9', rateControl: ['-crf', '18', '-b:v', '0'] }
};

function parseUntrustedRational(text, label) {
  const match = typeof text === 'string' ? /^(\d+)\/(\d+)$/.exec(text.trim()) : null;
  if (!match) throw new Error(label + ' is not an integer rational frame rate like 30000/1001.');
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 || numerator / denominator > MAX_FRAME_RATE) {
    throw new Error(label + ' is not a usable positive frame rate rational.');
  }
  return { numerator, denominator };
}

function parseUntrustedCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(label + ' is not a usable non-negative integer frame count.');
  return count;
}

function parseUntrustedDimension(value, label) {
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 100_000) throw new Error(label + ' is not a usable media dimension.');
  return dimension;
}

function parseUntrustedSeconds(value, label) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(label + ' is not a usable non-negative duration.');
  return Math.round(seconds * 1e6) / 1e6;
}

// Codec names and other embedded strings are untrusted: only fixed-shape tokens
// are ever echoed into manifests. Everything else (tags, titles, comments) is dropped.
function parseUntrustedToken(value) {
  return typeof value === 'string' && SAFE_MEDIA_TOKEN.test(value) ? value : null;
}

function approximateRational(value, maxDenominator = 1001) {
  let bestNumerator = Math.round(value);
  let bestDenominator = 1;
  let bestError = Math.abs(value - bestNumerator);
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, remaining = value;
  for (let step = 0; step < 40 && bestError > 0; step += 1) {
    const term = Math.floor(remaining);
    const h2 = term * h1 + h0;
    const k2 = term * k1 + k0;
    if (k2 > maxDenominator || h2 <= 0) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    const error = Math.abs(value - h1 / k1);
    if (error < bestError) { bestError = error; bestNumerator = h1; bestDenominator = k1; }
    const fraction = remaining - term;
    if (fraction <= 0) break;
    remaining = 1 / fraction;
  }
  return { numerator: bestNumerator, denominator: bestDenominator };
}

function resolveFrameRate(fps) {
  if (fps !== null && typeof fps === 'object' && !Array.isArray(fps)) {
    const { numerator, denominator } = fps;
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 || numerator / denominator > MAX_FRAME_RATE) {
      throw new Error('fps must be a positive frame rate number or a {numerator, denominator} integer rational.');
    }
    return { numerator, denominator };
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > MAX_FRAME_RATE) {
    throw new Error('fps must be a positive frame rate number or a {numerator, denominator} integer rational.');
  }
  if (Number.isSafeInteger(fps)) return { numerator: fps, denominator: 1 };
  const approximated = approximateRational(fps);
  if (approximated.numerator <= 0) throw new Error('fps could not be represented as an integer rational.');
  return approximated;
}

// Exact rational seek timestamps floored to microseconds with BigInt arithmetic so
// the -ss target never rounds above the requested frame's presentation timestamp.
function rationalMicrosecondsString(frames, rate) {
  const total = BigInt(frames) * BigInt(rate.denominator) * MICROSECONDS_PER_SECOND / BigInt(rate.numerator);
  const whole = total / MICROSECONDS_PER_SECOND;
  const fraction = total % MICROSECONDS_PER_SECOND;
  return whole.toString() + '.' + fraction.toString().padStart(6, '0');
}

async function probeVideoStream(source, { ffprobe, timeoutMs }) {
  const result = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=r_frame_rate,avg_frame_rate,nb_read_frames,codec_name,width,height',
    '-show_entries', 'format=duration', '-of', 'json', source
  ], { timeoutMs });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('FFprobe returned invalid JSON.'); }
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  if (!stream || typeof stream !== 'object') throw new Error('No video stream was found in ' + source + '.');
  let rationalFps;
  try {
    rationalFps = parseUntrustedRational(stream.r_frame_rate, 'r_frame_rate');
  } catch {
    rationalFps = parseUntrustedRational(stream.avg_frame_rate, 'avg_frame_rate');
  }
  return {
    frameCount: parseUntrustedCount(stream.nb_read_frames, 'nb_read_frames'),
    rationalFps,
    width: parseUntrustedDimension(stream.width, 'width'),
    height: parseUntrustedDimension(stream.height, 'height'),
    videoCodec: parseUntrustedToken(stream.codec_name),
    durationSeconds: parsed.format && parsed.format.duration !== undefined ? parseUntrustedSeconds(parsed.format.duration, 'format duration') : null
  };
}

async function probeAudioStream(source, { ffprobe, timeoutMs }) {
  const result = await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,duration', '-of', 'json', source], { timeoutMs });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('FFprobe returned invalid JSON.'); }
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  if (!stream || typeof stream !== 'object') return { hasAudio: false, audioCodec: null, audioDurationSeconds: null };
  return {
    hasAudio: true,
    audioCodec: parseUntrustedToken(stream.codec_name),
    audioDurationSeconds: stream.duration !== undefined ? parseUntrustedSeconds(stream.duration, 'audio duration') : null
  };
}

async function probeMediaStreams(source, { ffprobe, timeoutMs }) {
  const settings = { ffprobe, timeoutMs };
  const [video, audio] = [await probeVideoStream(source, settings), await probeAudioStream(source, settings)];
  return { video, audio };
}

/**
 * Ingest one real footage source into a project: probe it (exact rational fps,
 * decoded frame count, duration), hash it, and produce an edit proxy (half-res
 * H.264, verified same frame count), thumbnail and optional waveform beside a
 * provenance manifest under <projectRoot>/assets/footage/<sha8>/. All probed
 * metadata is treated as untrusted input: only validated numerics and fixed-shape
 * tokens are echoed, embedded tags are never copied into the manifest.
 */
export async function ingestFootage({ sourcePath, projectRoot, fps, thumbnailAtSeconds = 1, timeoutMs = 120000, overwrite = false, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('sourcePath is required.');
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new Error('projectRoot is required.');
  if (!Number.isFinite(thumbnailAtSeconds) || thumbnailAtSeconds < 0 || thumbnailAtSeconds > 86400) {
    throw new Error('thumbnailAtSeconds must be between 0 and 86400.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be between 1000 and 600000.');
  const requestedFps = fps === undefined ? null : resolveFrameRate(fps);
  const source = path.resolve(sourcePath);
  const root = path.resolve(projectRoot);
  const sourceInfo = await assertRegularSource(source);
  const sourceHash = await sha256(source);
  await mkdir(root, { recursive: true });
  await assertPathHasNoSymlinks(root, 'directory', 'Project root must be reached without symlinked path components.');
  const probeOptions = { ffprobe: ffprobePath, timeoutMs };
  const { video, audio } = await probeMediaStreams(source, probeOptions);
  const sha8 = sourceHash.slice(0, 8);
  const outputDirectory = path.resolve(root, 'assets', 'footage', sha8);
  if (!within(root, outputDirectory) || outputDirectory === root) throw new Error('Footage output directory escaped the project root.');
  await mkdir(outputDirectory, { recursive: true });
  await assertPathHasNoSymlinks(outputDirectory, 'directory', 'Footage output directory must be reached without symlinked path components.');
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  try {
    const existing = await lstat(manifestPath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Refusing to replace a non-regular footage manifest: ' + manifestPath);
    if (!overwrite) throw new Error('Footage already ingested (pass overwrite=true to replace): ' + manifestPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const derivatives = [];
  const writeDerivative = async (kind, fileName, mimeType, args, verify) => {
    const target = path.join(outputDirectory, fileName);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Refusing to overwrite a non-regular derivative target: ' + target);
      if (!overwrite) throw new Error('Derivative already exists (pass overwrite=true to replace): ' + target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, overwrite ? '-y' : '-n', target], { timeoutMs });
      const info = await stat(target);
      if (!info.isFile() || info.size === 0) throw new Error('FFmpeg produced an empty or invalid derivative: ' + target);
      if (verify) await verify(target);
      derivatives.push({ kind, fileName, path: target, mimeType, byteSize: info.size, sha256: await sha256(target) });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  };

  const proxyWidth = Math.max(2, Math.floor(video.width / 4) * 2);
  const proxyHeight = Math.max(2, Math.floor(video.height / 4) * 2);
  const proxyArgs = ['-i', source, '-map', '0:v:0', '-map', '0:a?',
    '-vf', 'scale=' + proxyWidth + ':' + proxyHeight,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  await writeDerivative('proxy', 'proxy.mp4', 'video/mp4', proxyArgs, async target => {
    const proxy = await probeVideoStream(target, probeOptions);
    if (proxy.frameCount !== video.frameCount) {
      throw new Error('Edit proxy frame count ' + proxy.frameCount + ' does not match source frame count ' + video.frameCount + ' for ' + source + '.');
    }
  });
  const seek = video.durationSeconds !== null && video.durationSeconds > 0
    ? Math.min(thumbnailAtSeconds, Math.max(0, video.durationSeconds / 2))
    : thumbnailAtSeconds;
  await writeDerivative('thumbnail', 'thumbnail.jpg', 'image/jpeg', [
    '-ss', String(seek), '-i', source, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=w=640:h=-2:force_original_aspect_ratio=decrease', '-q:v', '3'
  ]);
  if (audio.hasAudio) {
    await writeDerivative('waveform', 'waveform.png', 'image/png', [
      '-i', source, '-filter_complex', '[0:a]showwavespic=s=1600x240:colors=white[w]', '-map', '[w]', '-frames:v', '1'
    ]);
  }

  const manifest = {
    manifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    sourcePath: source,
    sourceByteSize: sourceInfo.size,
    sha256: sourceHash,
    rationalFps: video.rationalFps,
    frameCount: video.frameCount,
    durationSeconds: video.durationSeconds,
    width: video.width,
    height: video.height,
    videoCodec: video.videoCodec,
    audioCodec: audio.audioCodec,
    hasAudio: audio.hasAudio,
    outputDirectory,
    derivatives
  };
  if (requestedFps) {
    manifest.requestedFps = requestedFps;
    manifest.frameRateMatch = requestedFps.numerator === video.rationalFps.numerator && requestedFps.denominator === video.rationalFps.denominator;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * Cut one exact frame range [startFrame, startFrame + durationFrames) out of a
 * video source with input seeking computed from the rational fps, re-encoding to
 * the same codec family. Fails closed when the range leaves the source, when the
 * rendered frame count is not exactly durationFrames, when the frame rate was
 * converted, or when the audio does not span the requested duration.
 */
export async function trimFootage({ sourcePath, outputPath, startFrame, durationFrames, fps, sourceFrameCount, overwrite = true, timeoutMs = 120000, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('sourcePath is required.');
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('outputPath is required.');
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame > MAX_FRAME_INDEX) throw new Error('startFrame must be a non-negative integer frame index.');
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > MAX_FRAME_INDEX) throw new Error('durationFrames must be a positive integer frame count.');
  if (sourceFrameCount !== undefined) parseUntrustedCount(sourceFrameCount, 'sourceFrameCount');
  const rate = resolveFrameRate(fps);
  const source = path.resolve(sourcePath);
  const target = path.resolve(outputPath);
  if (source === target) throw new Error('Trim output path must differ from the source path.');
  await assertRegularSource(source);
  const outputDirectory = path.dirname(target);
  await mkdir(outputDirectory, { recursive: true });
  await assertPathHasNoSymlinks(outputDirectory, 'directory', 'Trim output directory must be reached without symlinked path components.');
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Refusing to overwrite a non-regular trim target: ' + target);
    if (!overwrite) throw new Error('Trim output already exists (pass overwrite=true to replace): ' + target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const probeOptions = { ffprobe: ffprobePath, timeoutMs };
  const { video, audio } = await probeMediaStreams(source, probeOptions);
  if (!video.videoCodec || !SAME_FAMILY_ENCODERS[video.videoCodec]) {
    throw new Error('No same-family encoder is available for source codec ' + (video.videoCodec || 'unknown') + ' in ' + source + '.');
  }
  const totalSourceFrames = sourceFrameCount === undefined ? video.frameCount : parseUntrustedCount(sourceFrameCount, 'sourceFrameCount');
  const endFrame = startFrame + durationFrames;
  if (endFrame > totalSourceFrames) {
    throw new Error('Trim range exceeds source: startFrame ' + startFrame + ' + durationFrames ' + durationFrames + ' = ' + endFrame + ' frames exceeds source frame count ' + totalSourceFrames + ' in ' + source + '.');
  }

  const startSeconds = rationalMicrosecondsString(startFrame, rate);
  const durationSeconds = rationalMicrosecondsString(durationFrames, rate);
  const codec = SAME_FAMILY_ENCODERS[video.videoCodec];
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', overwrite ? '-y' : '-n',
    '-ss', startSeconds, '-i', source, '-t', durationSeconds,
    '-map', '0:v:0'];
  if (audio.hasAudio) args.push('-map', '0:a?');
  args.push('-c:v', codec.encoder, ...codec.rateControl, '-pix_fmt', 'yuv420p', '-frames:v', String(durationFrames));
  if (audio.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  if (CONTAINER_FASTSTART_EXTENSIONS.has(path.extname(target).toLowerCase())) args.push('-movflags', '+faststart');
  args.push(target);
  try {
    await run(ffmpegPath, args, { timeoutMs });
    const outputVideo = await probeVideoStream(target, probeOptions);
    const outputAudio = await probeAudioStream(target, probeOptions);
    if (outputVideo.frameCount !== durationFrames) {
      throw new Error('FFmpeg trim produced ' + outputVideo.frameCount + ' frames; expected exactly ' + durationFrames + ' for range [' + startFrame + ', ' + endFrame + ') of ' + source + '.');
    }
    if (outputVideo.rationalFps.numerator !== video.rationalFps.numerator || outputVideo.rationalFps.denominator !== video.rationalFps.denominator) {
      throw new Error('Trim converted the frame rate from ' + video.rationalFps.numerator + '/' + video.rationalFps.denominator + ' to ' + outputVideo.rationalFps.numerator + '/' + outputVideo.rationalFps.denominator + '; frame-accurate trims must not convert frame rates.');
    }
    if (audio.hasAudio && !outputAudio.hasAudio) throw new Error('Trim dropped the audio stream of ' + source + '; editorial trims must retain audio for sync.');
    const audioDurationSeconds = outputAudio.hasAudio ? outputAudio.audioDurationSeconds : null;
    if (audio.hasAudio) {
      const requested = Number(durationSeconds);
      if (audioDurationSeconds === null || Math.abs(audioDurationSeconds - requested) > 0.1) {
        throw new Error('Trim audio duration ' + (audioDurationSeconds === null ? 'unknown' : audioDurationSeconds + 's') + ' deviates from the requested ' + requested + 's by more than 0.1s.');
      }
    }
    const info = await stat(target);
    if (!info.isFile() || info.size === 0) throw new Error('FFmpeg produced an empty trim output: ' + target);
    return {
      trimVersion: '1.0.0',
      verifiedAt: new Date().toISOString(),
      source: { path: source, frameCount: totalSourceFrames, rationalFps: video.rationalFps },
      output: { path: target, byteSize: info.size, sha256: await sha256(target), frameCount: outputVideo.frameCount, rationalFps: outputVideo.rationalFps, videoCodec: outputVideo.videoCodec },
      startFrame, durationFrames, endFrame,
      startSeconds: Number(startSeconds),
      durationSeconds: Number(durationSeconds),
      frameRate: rate,
      verified: { withinSource: true, frameCountExact: true, frameRateUnchanged: true, audioDurationSeconds }
    };
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

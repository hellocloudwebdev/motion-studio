import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
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

async function assertRegularSource(source) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile() || await realpath(source) !== source) throw new Error('Media source must be a regular, non-symlink file reached without symlinked path components.');
  return info;
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
  const outputInfo = await lstat(outputRoot);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || await realpath(outputRoot) !== outputRoot) throw new Error('Output directory must be reached without symlinked path components.');
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

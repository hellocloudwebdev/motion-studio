import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Shared workspace containment for every local provider: the logical path must
// stay inside the project root, and after mkdir the real (symlink-resolved)
// directory is re-checked so escapes through links fail closed. Mirrors the
// speech-adapter containment pattern (roadmap P3.1).
export async function prepareWorkspaceOutput({ projectRoot, outputPath, label = 'Provider output' }) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new Error('A projectRoot and outputPath are required for isolated provider generation.');
  }
  const root = path.resolve(projectRoot), output = path.resolve(outputPath);
  if (!inside(root, output)) throw new Error(label + ' must remain inside the project workspace.');
  await mkdir(path.dirname(output), { recursive: true });
  const realRoot = await realpath(root), realDirectory = await realpath(path.dirname(output));
  if (!inside(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error(label + ' directory escapes the project workspace.');
  return { root, output, realRoot, realDirectory };
}

export function run(executable, args, { cwd, signal, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(executable + ' failed with exit code ' + code + '. ' + (stderr || stdout).slice(-4000)));
    });
  });
}

export async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function probeAudio(file, { signal, label = 'Provider audio output' } = {}) {
  const result = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const report = JSON.parse(result.stdout), audio = (report.streams || []).find(stream => stream.codec_type === 'audio');
  const durationSeconds = Number(report.format?.duration || audio?.duration || 0);
  if (!audio || !(durationSeconds > 0)) throw new Error(label + ' failed independent FFprobe audio verification.');
  return { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, durationSeconds };
}

export async function probeImage(file, { signal, label = 'Provider image output' } = {}) {
  const result = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file], { signal });
  const report = JSON.parse(result.stdout), image = (report.streams || []).find(stream => stream.codec_type === 'video');
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(label + ' failed independent FFprobe image verification.');
  }
  return { codec: image.codec_name, width: image.width, height: image.height };
}

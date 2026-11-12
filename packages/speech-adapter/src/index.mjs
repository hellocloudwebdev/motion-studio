import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WINDOWS_SAPI_SCRIPT = path.join(MODULE_ROOT, 'scripts', 'windows-sapi-speech.ps1');

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function assertValidSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Speech text must contain 1–100000 characters.');
}

export function resolveSpeechCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.WINDIR;
    if (!systemRoot) throw new Error('Windows SAPI needs the Windows system root environment path.');
    return { executable: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), argsPrefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', WINDOWS_SAPI_SCRIPT], extension: '.wav', provider: 'windows-sapi' };
  }
  if (platform === 'darwin') return { executable: '/usr/bin/say', argsPrefix: [], extension: '.aiff', provider: 'macos-say' };
  if (platform === 'linux') return { executable: '/usr/bin/espeak', argsPrefix: [], extension: '.wav', provider: 'espeak' };
  throw new Error('No offline speech adapter is supported on ' + platform + '.');
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
      else reject(new Error('Local speech process failed with exit code ' + code + '. ' + (stderr || stdout).slice(-4000)));
    });
  });
}

export async function probeAudio(file, { signal, label = 'Local speech output' } = {}) {
  const result = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const report = JSON.parse(result.stdout), audio = (report.streams || []).find(stream => stream.codec_type === 'audio');
  const durationSeconds = Number(report.format?.duration || audio?.duration || 0);
  if (!audio || !(durationSeconds > 0)) throw new Error(label + ' failed independent FFprobe audio verification.');
  return { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, durationSeconds };
}

export async function generateSpeech(text, { outputPath, projectRoot, signal, timeoutMs = 120_000 } = {}) {
  assertValidSpeechText(text);
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('A projectRoot and outputPath are required for isolated speech generation.');
  const root = path.resolve(projectRoot), output = path.resolve(outputPath);
  if (!inside(root, output)) throw new Error('Speech output must remain inside the project workspace.');
  await mkdir(path.dirname(output), { recursive: true });
  const realRoot = await realpath(root), realDirectory = await realpath(path.dirname(output));
  if (!inside(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error('Speech output directory escapes the project workspace.');
  const info = resolveSpeechCommand();
  await access(info.executable);
  if (info.provider === 'windows-sapi') await access(WINDOWS_SAPI_SCRIPT);
  const runId = process.pid + '-' + Date.now();
  const textFile = path.join(realDirectory, '.speech-' + runId + '.txt');
  const rawOutput = path.join(realDirectory, '.speech-source-' + runId + info.extension);
  const trimmedOutput = path.join(realDirectory, '.speech-trimmed-' + runId + info.extension);
  await writeFile(textFile, text.trim(), { encoding: 'utf8', flag: 'wx' });
  try {
    let args;
    if (info.provider === 'windows-sapi') args = [...info.argsPrefix, textFile, rawOutput];
    else if (info.provider === 'macos-say') args = ['-f', textFile, '-o', rawOutput];
    else args = ['-f', textFile, '-w', rawOutput];
    const execution = await run(info.executable, args, { cwd: realDirectory, signal, timeoutMs });
    const rawStat = await stat(rawOutput);
    if (!rawStat.isFile() || rawStat.size === 0) throw new Error('Local speech engine returned no output file.');
    const sourceAudio = await probeAudio(rawOutput, { signal });
    const outputCodec = info.extension === '.aiff' ? 'pcm_s16be' : 'pcm_s16le';
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawOutput, '-af', 'areverse,silenceremove=start_periods=1:start_duration=0.35:start_threshold=-60dB:start_silence=0.15,areverse', '-c:a', outputCodec, trimmedOutput], { cwd: realDirectory, signal, timeoutMs });
    const audio = await probeAudio(trimmedOutput, { signal });
    const outputStat = await stat(trimmedOutput);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('Silence-trimmed local speech output is empty.');
    await rename(trimmedOutput, output);
    const digest = createHash('sha256').update(await readFile(output)).digest('hex');
    return { provider: info.provider, output, sha256: digest, byteSize: outputStat.size, audio, sourceAudioDurationSeconds: sourceAudio.durationSeconds, trailingSilenceTrimmed: Math.max(0, sourceAudio.durationSeconds - audio.durationSeconds), verified: true, process: { exitCode: execution.code, logTail: (execution.stderr || execution.stdout).slice(-1000) } };
  } finally {
    await Promise.all([rm(textFile, { force: true }), rm(rawOutput, { force: true }), rm(trimmedOutput, { force: true })]);
  }
}

export function narrationTextFromProject(project) {
  return narrationSegmentsFromProject(project).map(item => item.text).join('\n\n');
}

export function narrationSegmentsFromProject(project) {
  const sources = [project?.production?.script, project?.planning?.script, project?.script].filter(Boolean);
  const segment = (text, item = {}) => ({ text: text.trim(), ...(Number.isInteger(item.leadInFrames) && item.leadInFrames > 0 ? { leadInFrames: item.leadInFrames } : {}) });
  for (const source of sources) {
    if (Array.isArray(source)) {
      const segments = source.filter(item => typeof item?.narration === 'string' && item.narration.trim()).map(item => segment(item.narration, item));
      if (segments.length) return segments;
    }
    if (typeof source.narration === 'string' && source.narration.trim()) return [{ text: source.narration.trim() }];
    if (Array.isArray(source.narrationSegments)) {
      const segments = source.narrationSegments.map(item => {
        const text = typeof item === 'string' ? item : item?.text || item?.narration;
        return typeof text === 'string' && text.trim() ? segment(text, typeof item === 'object' ? item : {}) : null;
      }).filter(Boolean);
      if (segments.length) return segments;
    }
    if (Array.isArray(source.segments)) {
      const segments = source.segments.filter(item => typeof item?.narration === 'string' && item.narration.trim()).map(item => segment(item.narration, item));
      if (segments.length) return segments;
    }
  }
  throw new Error('Canonical Video IR does not contain narration text in production.script, planning.script or script.');
}

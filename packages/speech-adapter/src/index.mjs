import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WINDOWS_SAPI_SCRIPT = path.join(MODULE_ROOT, 'scripts', 'windows-sapi-speech.ps1');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
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

function run(executable, args, { cwd, signal, timeoutMs = 120_000 } = {}) {
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

async function probeAudio(file, { signal } = {}) {
  const result = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const report = JSON.parse(result.stdout), audio = (report.streams || []).find(stream => stream.codec_type === 'audio');
  const durationSeconds = Number(report.format?.duration || audio?.duration || 0);
  if (!audio || !(durationSeconds > 0)) throw new Error('Local speech output failed independent FFprobe audio verification.');
  return { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, durationSeconds };
}

export async function generateSpeech(text, { outputPath, projectRoot, signal, timeoutMs = 120_000 } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Speech text must contain 1–100000 characters.');
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('A projectRoot and outputPath are required for isolated speech generation.');
  const root = path.resolve(projectRoot), output = path.resolve(outputPath);
  if (!inside(root, output)) throw new Error('Speech output must remain inside the project workspace.');
  await mkdir(path.dirname(output), { recursive: true });
  const realRoot = await realpath(root), realDirectory = await realpath(path.dirname(output));
  if (!inside(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error('Speech output directory escapes the project workspace.');
  const info = resolveSpeechCommand();
  await access(info.executable);
  if (info.provider === 'windows-sapi') await access(WINDOWS_SAPI_SCRIPT);
  const textFile = path.join(realDirectory, '.speech-' + process.pid + '-' + Date.now() + '.txt');
  await writeFile(textFile, text.trim(), { encoding: 'utf8', flag: 'wx' });
  try {
    let args;
    if (info.provider === 'windows-sapi') args = [...info.argsPrefix, textFile, output];
    else if (info.provider === 'macos-say') args = ['-f', textFile, '-o', output];
    else args = ['-f', textFile, '-w', output];
    const execution = await run(info.executable, args, { cwd: realDirectory, signal, timeoutMs });
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('Local speech engine returned no output file.');
    const audio = await probeAudio(output, { signal });
    const digest = createHash('sha256').update(await readFile(output)).digest('hex');
    return { provider: info.provider, output, sha256: digest, byteSize: outputStat.size, audio, verified: true, process: { exitCode: execution.code, logTail: (execution.stderr || execution.stdout).slice(-1000) } };
  } finally { await rm(textFile, { force: true }); }
}

export function narrationTextFromProject(project) {
  return narrationSegmentsFromProject(project).map(item => item.text).join('\n\n');
}

export function narrationSegmentsFromProject(project) {
  const sources = [project?.production?.script, project?.planning?.script, project?.script].filter(Boolean);
  for (const source of sources) {
    if (Array.isArray(source)) {
      const segments = source.map(item => item?.narration).filter(value => typeof value === 'string' && value.trim()).map(text => ({ text: text.trim() }));
      if (segments.length) return segments;
    }
    if (typeof source.narration === 'string' && source.narration.trim()) return [{ text: source.narration.trim() }];
    if (Array.isArray(source.narrationSegments)) {
      const segments = source.narrationSegments.map(item => typeof item === 'string' ? item : item?.text || item?.narration).filter(value => typeof value === 'string' && value.trim()).map(text => ({ text: text.trim() }));
      if (segments.length) return segments;
    }
    if (Array.isArray(source.segments)) {
      const segments = source.segments.map(item => item?.narration).filter(value => typeof value === 'string' && value.trim()).map(text => ({ text: text.trim() }));
      if (segments.length) return segments;
    }
  }
  throw new Error('Canonical Video IR does not contain narration text in production.script, planning.script or script.');
}

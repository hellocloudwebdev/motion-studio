import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

let toolchain = null;

function probe(executable, args) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
}

// Fixture and recovery tests need Blender, FFprobe and FFmpeg on PATH;
// environments without them skip instead of failing the suite.
export async function blenderToolchainAvailable() {
  if (toolchain === null) {
    const [blender, ffprobe, ffmpeg] = await Promise.all([probe('blender', ['--version']), probe('ffprobe', ['-version']), probe('ffmpeg', ['-version'])]);
    toolchain = blender && ffprobe && ffmpeg;
  }
  return toolchain;
}

// MD5 of the decoded pixels of a rendered frame, per the FFmpeg framehash
// muxer. Lets fixture tests assert actual rendered motion instead of trusting
// receipt metadata alone.
export function decodedFrameSignature(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'md5', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error('FFmpeg could not decode ' + file + ': ' + stderr.slice(-2000))));
  });
}

// On Windows a just-killed Blender child can keep directory handles busy for a
// moment after the abort settles, so temp-root cleanup retries briefly on the
// transient lock codes instead of failing the test.
export async function removeDirectoryWithRetries(root, { attempts = 5, delayMs = 200 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

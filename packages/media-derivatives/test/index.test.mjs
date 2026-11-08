import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateMediaDerivatives } from '../src/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-derivatives-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: false }).status === 0;

test('rejects unsupported files and invalid profiles before invoking media tools', async () => fixture(async root => {
  const source = path.join(root, 'notes.txt');
  await writeFile(source, 'not media');
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'out')), /Unsupported media type/);
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'out'), { profile: 'fastest' }), /profile must be/);
}));

test('rejects symlinked sources', { skip: process.platform === 'win32' }, async () => fixture(async root => {
  const source = path.join(root, 'source.mp4');
  const link = path.join(root, 'linked.mp4');
  await writeFile(source, 'source');
  const { symlink } = await import('node:fs/promises');
  await symlink(source, link);
  await assert.rejects(generateMediaDerivatives(link, path.join(root, 'out')), /regular, non-symlink/);
}));

test('creates deterministic video proxy and thumbnail without mutating source', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = path.join(root, 'sample.mp4');
  const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source], { shell: false, stdio: 'ignore' });
  if (made.status !== 0) return;
  const before = await readFile(source);
  const result = await generateMediaDerivatives(source, path.join(root, 'derived'), { profile: 'all' });
  assert.deepEqual(result.outputs.map(item => item.kind).sort(), ['proxy', 'thumbnail']);
  assert.equal((await readFile(source)).equals(before), true);
  for (const output of result.outputs) {
    assert.ok((await lstat(output.path)).isFile());
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'derived'), { profile: 'all' }), /already exists/);
}));

test('creates waveform image for audio-only sources', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = path.join(root, 'tone.wav');
  const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', source], { shell: false, stdio: 'ignore' });
  if (made.status !== 0) return;
  const result = await generateMediaDerivatives(source, path.join(root, 'derived'));
  assert.deepEqual(result.outputs.map(item => item.kind), ['waveform']);
  assert.equal(result.outputs[0].mimeType, 'image/png');
}));

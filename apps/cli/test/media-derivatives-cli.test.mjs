import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('apps/cli/src/index.mjs');
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: false }).status === 0;

test('CLI creates derivative files and an optional provenance manifest', { skip: !ffmpegAvailable }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-media-cli-'));
  try {
    const source = path.join(root, 'source.mp4');
    const output = path.join(root, 'derived');
    const manifest = path.join(root, 'derivatives.json');
    const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source], { shell: false, stdio: 'ignore' });
    assert.equal(made.status, 0, 'FFmpeg must be able to create the test fixture');
    const result = spawnSync(process.execPath, [cli, 'media', 'derive', source, '--output-dir', output, '--manifest', manifest], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.deepEqual(saved.outputs.map(item => item.kind).sort(), ['proxy', 'thumbnail']);
    assert.equal(saved.source.sha256.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHyperFramesCli } from './index.mjs';

test('render manager process execution never uses shell interpolation', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('motion-render-ok')"], { shell: false, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => output += text);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0);
  assert.equal(output, 'motion-render-ok');
});

test('resolves the HyperFrames CLI from the npm package bin field', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-cli-'));
  try {
    const packageDir = path.join(root, 'node_modules', 'hyperframes');
    await mkdir(path.join(packageDir, 'bin'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.8.86', bin: { hyperframes: './bin/hyperframes.mjs' } }));
    await writeFile(path.join(packageDir, 'bin', 'hyperframes.mjs'), '#!/usr/bin/env node\n');
    const result = await resolveHyperFramesCli(root);
    assert.equal(result.version, '0.8.86');
    assert.equal(result.entry, path.join(packageDir, 'bin', 'hyperframes.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a package bin path that escapes the package directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-escape-'));
  try {
    const packageDir = path.join(root, 'node_modules', 'hyperframes');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.8.86', bin: { hyperframes: '../../outside.mjs' } }));
    await assert.rejects(() => resolveHyperFramesCli(root), /escapes its package directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

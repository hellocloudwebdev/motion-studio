import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('apps/cli/src/index.mjs');
test('CLI scans and verifies a local asset folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-cli-assets-'));
  try {
    const media = path.join(root, 'media');
    const registryFile = path.join(root, 'asset-registry.json');
    await import('node:fs/promises').then(fs => fs.mkdir(media));
    await writeFile(path.join(media, 'logo.png'), Buffer.from('logo-bytes'));
    const scan = spawnSync(process.execPath, [cli, 'assets', 'scan', media, '--output', registryFile], { encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr || scan.stdout);
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    assert.equal(registry.assetCount, 1);
    const verify = spawnSync(process.execPath, [cli, 'assets', 'verify', registryFile], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /"valid": true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

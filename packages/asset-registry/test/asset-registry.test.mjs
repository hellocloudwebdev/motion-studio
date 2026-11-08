import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanAssetDirectory, verifyAssetRegistry, approveAssetRights } from '../src/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-assets-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('scan indexes supported media deterministically with content-addressed ids', async () => fixture(async root => {
  await mkdir(path.join(root, 'footage'));
  await writeFile(path.join(root, 'footage', 'a.mp4'), Buffer.from('same-content'));
  await writeFile(path.join(root, 'footage', 'copy.mp4'), Buffer.from('same-content'));
  await writeFile(path.join(root, 'footage', 'music.wav'), Buffer.from('audio'));
  await writeFile(path.join(root, 'ignore.txt'), 'ignore me');
  const registry = await scanAssetDirectory(root);
  assert.equal(registry.assetCount, 3);
  assert.equal(registry.summary.byKind.video, 2);
  assert.equal(registry.summary.byKind.audio, 1);
  assert.equal(registry.summary.needsRightsReview, 3);
  assert.equal(registry.duplicates.length, 1);
  assert.equal(registry.assets[0].id, registry.assets[1].id);
  assert.equal(registry.assets[0].sha256, registry.assets[1].sha256);
}));

test('verify detects missing files and checksum changes', async () => fixture(async root => {
  await writeFile(path.join(root, 'image.png'), Buffer.from('original'));
  const registry = await scanAssetDirectory(root);
  assert.equal((await verifyAssetRegistry(registry)).valid, true);
  await writeFile(path.join(root, 'image.png'), Buffer.from('modified'));
  const result = await verifyAssetRegistry(registry);
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].reason, 'CHECKSUM_MISMATCH');
}));

test('rights approval requires actor, license and usage scope and is auditable', async () => fixture(async root => {
  await writeFile(path.join(root, 'track.wav'), Buffer.from('audio'));
  const registry = await scanAssetDirectory(root);
  const id = registry.assets[0].id;
  assert.throws(() => approveAssetRights(registry, { assetId: id, actor: 'producer', license: 'CC BY', usageScope: '' }), /usageScope is required/);
  const updated = approveAssetRights(registry, { assetId: id, actor: 'producer', license: 'CC BY 4.0', usageScope: 'online advertising', attribution: 'Artist name' });
  assert.equal(updated.assets[0].metadata.rightsStatus, 'approved');
  assert.equal(updated.assets[0].metadata.rightsApproval.actor, 'producer');
  assert.equal(updated.summary.needsRightsReview, 0);
  assert.equal(registry.assets[0].metadata.rightsStatus, 'needs-review');
}));

test('verify rejects registry paths that escape the configured root', async () => fixture(async root => {
  const registry = { registryVersion: '1.0.0', rootPath: root, assets: [{ id: 'bad', relativePath: '../outside.mp4', sha256: '0'.repeat(64) }] };
  const result = await verifyAssetRegistry(registry);
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].reason, 'PATH_OUTSIDE_ROOT');
}));

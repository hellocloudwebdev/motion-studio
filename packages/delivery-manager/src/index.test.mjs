import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDeliveryPackage, verifyDeliveryPackage } from './index.mjs';
import { runMediaCommand } from '../../ffmpeg/src/index.mjs';

async function makeVideo(file) {
  await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

function project(assets = []) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'delivery-test', name: 'Delivery test', objective: 'Verify package integrity.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180 }, totalDurationFrames: 60, revision: 3 },
    creative: { concept: 'A test', audience: 'Test', message: 'Integrity.' }, assets,
    scenes: [{ id: 'scene-1', name: 'Scene', intent: 'Test', durationFrames: 60, layers: [{ id: 'plate', kind: 'shape' }, ...(assets.length ? [{ id: 'photo', kind: 'image', assetId: assets[0].id }] : [])] }],
    captions: [{ startFrame: 0, endFrame: 30, text: 'Hello package' }],
    delivery: { primaryTargetId: 'master', targets: [{ id: 'master', format: 'mp4', width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', audioRequired: false }] }
  };
}

test('packages only referenced assets, rewrites a portable IR and verifies package hashes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-delivery-'));
  try {
    const projectDir = path.join(root, 'project');
    const packageRoot = path.join(root, 'delivery');
    await mkdir(projectDir);
    const assetBytes = Buffer.from('approved still');
    await writeFile(path.join(projectDir, 'still.png'), assetBytes);
    const assets = [
      { id: 'still', kind: 'image', uri: 'still.png', sha256: createHash('sha256').update(assetBytes).digest('hex'), rightsStatus: 'user-owned' },
      { id: 'unused', kind: 'image', uri: 'missing.png', rightsStatus: 'unknown' }
    ];
    const input = project(assets), projectFile = path.join(projectDir, 'project.json'), sourceVideo = path.join(root, 'source.mp4');
    await writeFile(projectFile, JSON.stringify(input, null, 2) + '\n');
    await makeVideo(sourceVideo);
    const canonicalSha = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = await buildDeliveryPackage({ project: input, projectFile, sourceVideo, projectRoot: root, outputRoot: packageRoot, renderManifest: { productionReady: true, verified: true, projectIrSha256: canonicalSha } });
    assert.equal(result.acceptance.passed, true);
    assert.equal(result.assetManifest ? JSON.parse(await readFile(result.assetManifest, 'utf8')).assets.length : 0, 1);
    const portable = JSON.parse(await readFile(result.portableProject.path, 'utf8'));
    assert.match(portable.assets[0].uri, /^assets\/still-/);
    assert.equal((await verifyDeliveryPackage(packageRoot)).passed, true);
    await writeFile(path.join(packageRoot, 'assets', path.basename(portable.assets[0].uri)), 'tampered');
    const tampered = await verifyDeliveryPackage(packageRoot);
    assert.equal(tampered.passed, false);
    assert.ok(tampered.failures.some(item => item.reason === 'integrity-mismatch'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delivery refuses to package a referenced asset that escapes the project root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-delivery-escape-'));
  try {
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    const input = project([{ id: 'escape', kind: 'image', uri: '../outside.png', rightsStatus: 'user-owned' }]);
    const projectFile = path.join(projectDir, 'project.json'), sourceVideo = path.join(root, 'source.mp4');
    await writeFile(projectFile, JSON.stringify(input));
    await makeVideo(sourceVideo);
    const result = await buildDeliveryPackage({ project: input, projectFile, sourceVideo, projectRoot: root, outputRoot: path.join(root, 'delivery'), renderManifest: { productionReady: true, verified: true, projectIrSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex') } });
    assert.equal(result.acceptance.passed, false);
    assert.match(result.limitations[0].reason, /project-relative path|escapes the project directory/);
    assert.equal((await verifyDeliveryPackage(path.join(root, 'delivery'))).passed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

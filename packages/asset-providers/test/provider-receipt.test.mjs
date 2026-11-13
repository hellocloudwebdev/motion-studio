import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachProviderReceipt, GENERATED_ASSET_LICENSE } from '../src/provider-receipt.mjs';
import { validateProject } from '../../core/src/index.mjs';

const digest = seed => createHash('sha256').update(seed).digest('hex');

function baseProject() {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'provider-demo', name: 'Provider Demo', objective: 'Prove provider receipts.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080 }, totalDurationFrames: 150 },
    creative: { concept: 'c', audience: 'a', message: 'm' },
    assets: [],
    scenes: [{ id: 'showcase', name: 'Showcase', intent: 'prove receipts', durationFrames: 150, layers: [{ id: 'backdrop', kind: 'image', startFrame: 0, durationFrames: 150 }] }],
    delivery: { targets: [{ width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] }
  };
}

async function receiptFixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-receipt-'));
  return {
    provider: 'ffmpeg-lavfi',
    kind: 'sfx',
    variant: 'whoosh',
    params: { kind: 'whoosh', durationSeconds: 1.5, frequency: 900, gain: 1.2, seed: 1729 },
    projectRoot: root,
    output: path.join(root, 'assets', 'sfx', 'whoosh.wav'),
    sha256: digest('whoosh-bytes'),
    byteSize: 132378,
    verified: true,
    rightsStatus: 'generated',
    terms: 'Locally synthesized, no third-party material',
    generatedAt: '2026-11-14T00:00:00.000Z',
    __root: root,
    ...overrides
  };
}

const cleanup = async receipt => rm(receipt.__root, { recursive: true, force: true });

test('attaches a validated, registry-shaped asset record derived from the receipt', async () => {
  const receipt = await receiptFixture();
  try {
    const input = baseProject();
    const { project, report } = attachProviderReceipt(input, receipt);
    assert.deepEqual(input.assets, [], 'the input project is not mutated');
    assert.notEqual(project, input, 'a fresh project is returned');
    assert.equal(project.assets.length, 1);
    const asset = project.assets[0];
    const expectedId = 'asset-' + createHash('sha256').update('sfx\0' + receipt.sha256).digest('hex').slice(0, 20);
    assert.equal(asset.id, expectedId, 'the id derives from kind + content hash');
    assert.equal(asset.contentId, 'content-' + receipt.sha256.slice(0, 20));
    assert.equal(asset.kind, 'audio', 'sfx maps to the audio registry kind');
    assert.equal(asset.uri, 'assets/sfx/whoosh.wav', 'uri is posix-relative to the project root');
    assert.equal(asset.mimeType, 'audio/wav');
    assert.equal(asset.sha256, receipt.sha256);
    assert.equal(asset.byteSize, receipt.byteSize);
    assert.equal(asset.metadata.source, 'ffmpeg-lavfi');
    assert.equal(asset.metadata.rightsStatus, 'generated');
    assert.equal(asset.metadata.approvedForFinalUse, true, 'locally synthesized assets are final-eligible');
    assert.equal(asset.metadata.license, GENERATED_ASSET_LICENSE);
    assert.equal(asset.metadata.terms, 'Locally synthesized, no third-party material');
    assert.deepEqual(asset.metadata.tags, ['provider-generated', 'sfx', 'whoosh']);
    assert.deepEqual(asset.metadata.params, receipt.params);
    assert.equal(asset.metadata.prompt, null);
    assert.equal(asset.metadata.rightsApproval, null);
    assert.deepEqual(report, { attached: 1, totalAssets: 1, rightsReviewRequired: [], nonFinalAssetIds: [] });
  } finally { await cleanup(receipt); }
});

test('derives default rights state from the provider', async () => {
  const generated = await receiptFixture({ rightsStatus: undefined });
  try {
    const { project, report } = attachProviderReceipt(baseProject(), generated);
    assert.equal(project.assets[0].metadata.rightsStatus, 'generated');
    assert.deepEqual(report.nonFinalAssetIds, []);
    const openRouter = await receiptFixture({
      provider: 'openrouter', kind: 'image', model: 'google/gemini-2.5-flash-image',
      prompt: 'A backdrop.', variant: undefined, rightsStatus: undefined,
      sha256: digest('image-bytes'), byteSize: 4242
    });
    try {
      openRouter.output = path.join(openRouter.__root, 'assets', 'images', 'scene.png');
      const result = attachProviderReceipt(baseProject(), openRouter);
      const asset = result.project.assets[0];
      assert.equal(asset.kind, 'image', 'image maps to the image registry kind');
      assert.equal(asset.mimeType, 'image/png');
      assert.equal(asset.metadata.rightsStatus, 'unknown', 'API providers default to unknown rights');
      assert.equal(asset.metadata.source, 'openrouter/google/gemini-2.5-flash-image', 'source records provider and model');
      assert.equal(asset.metadata.prompt, 'A backdrop.');
      assert.equal(asset.metadata.license, null, 'unknown rights carry no license claim');
      assert.equal(asset.metadata.approvedForFinalUse, false, 'unknown rights are non-final by default');
      assert.deepEqual(result.report.rightsReviewRequired, [asset.id]);
      assert.deepEqual(result.report.nonFinalAssetIds, [asset.id]);
    } finally { await cleanup(openRouter); }
  } finally { await cleanup(generated); }
});

test('rejects malformed or unverified receipts fail-closed', async () => {
  const base = await receiptFixture();
  try {
    const project = baseProject();
    await assert.throws(() => attachProviderReceipt(null, base), /Canonical Video IR project object is required/);
    await assert.throws(() => attachProviderReceipt(project, null), /provider receipt object is required/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, kind: 'holo' }), /Unknown provider capability kind: holo/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, provider: '  ' }), /provider must be a non-empty string/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, sha256: 'deadbeef' }), /sha256 must contain 64 hexadecimal/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, byteSize: 0 }), /byteSize must be a positive integer/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, byteSize: 132.5 }), /byteSize must be a positive integer/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, verified: false }), /only accepts FFprobe-verified receipts/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, verified: undefined }), /only accepts FFprobe-verified receipts/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, projectRoot: '' }), /projectRoot must be a non-empty string/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, output: path.join(base.__root, '..', 'escape.wav') }), /escapes the project workspace/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, rightsStatus: 'trusted' }), /rightsStatus must be one of/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, rightsStatus: 'approved' }), /approved receipt requires an approval object/);
    await assert.throws(() => attachProviderReceipt(project, { ...base, rightsStatus: 'approved', approval: { actor: 'producer', license: '', usageScope: 'demo' } }), /approval.license must be a non-empty string/);
  } finally { await cleanup(base); }
});

test('same content updates in place; a pre-existing colliding id with different content is rejected', async () => {
  const receipt = await receiptFixture();
  try {
    const first = attachProviderReceipt(baseProject(), receipt);
    const second = attachProviderReceipt(first.project, { ...receipt, variant: 'pop', title: 'Custom title' });
    assert.equal(second.project.assets.length, 1, 're-attaching the same content updates in place');
    assert.equal(second.project.assets[0].metadata.title, 'Custom title');
    const collidingId = first.project.assets[0].id;
    const withCollision = baseProject();
    withCollision.assets = [{ id: collidingId, kind: 'audio', sha256: digest('different-bytes') }];
    assert.throws(() => attachProviderReceipt(withCollision, receipt), /Asset id collision with different content/);
  } finally { await cleanup(receipt); }
});

test('attached records produce a project that passes core validateProject with resolved references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-receipt-ir-'));
  const sfxReceipt = {
    provider: 'ffmpeg-lavfi', kind: 'sfx', variant: 'whoosh',
    params: { kind: 'whoosh', durationSeconds: 1.5 },
    projectRoot: root, output: path.join(root, 'assets', 'provider', 'sfx-whoosh.wav'),
    sha256: digest('whoosh-bytes'), byteSize: 132378, verified: true,
    rightsStatus: 'generated', terms: 'Locally synthesized, no third-party material'
  };
  const bedReceipt = {
    provider: 'ffmpeg-lavfi', kind: 'music-bed', variant: 'uplift',
    params: { durationSeconds: 5, key: 'C', bpm: 96, mood: 'uplift' },
    projectRoot: root, output: path.join(root, 'assets', 'provider', 'music-bed.wav'),
    sha256: digest('bed-bytes'), byteSize: 882078, verified: true,
    rightsStatus: 'generated', terms: 'Locally synthesized, no third-party material'
  };
  try {
    const first = attachProviderReceipt(baseProject(), sfxReceipt);
    const { project, report } = attachProviderReceipt(first.project, bedReceipt);
    assert.equal(report.totalAssets, 2);
    const [whooshAsset, bedAsset] = project.assets;
    project.scenes[0].audioCues = [
      { assetId: bedAsset.id, offsetFrames: 0, durationFrames: 150, fadeInFrames: 15, fadeOutFrames: 30, volume: 0.8 },
      { assetId: whooshAsset.id, offsetFrames: 0, durationFrames: 45, volume: 1 }
    ];
    const validation = validateProject(project);
    assert.deepEqual(validation.issues, [], 'expected a fully valid IR, received: ' + JSON.stringify(validation.issues));
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.summary, { errors: 0, warnings: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPremiereInterchange } from '../src/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'motion-studio-premiere-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function assembly(uri, checksum = 'a'.repeat(64)) {
  return {
    assemblyVersion: '1.0.0',
    project: { id: 'launch', name: 'Launch', frameRate: { numerator: 30000, denominator: 1001 } },
    sequence: { name: 'Launch Sequence', durationFrames: 300 },
    scenes: [{ sceneId: 's1', startFrame: 0, endFrame: 300 }],
    clips: [{
      clipId: 'hero', sceneId: 's1', name: 'Hero & Product', kind: 'video', family: 'video', track: 'V1',
      startFrame: 30, endFrame: 180, durationFrames: 150, sourceInFrame: 15,
      assetId: 'hero', sourceUri: uri, sourceSha256: checksum, rightsStatus: 'approved', media: true
    }]
  };
}

test('exports frame-accurate FCPXML and preserves provenance in a sidecar', async () => fixture(async root => {
  const source = path.join(root, 'hero.mp4');
  await writeFile(source, 'media');
  const result = await exportPremiereInterchange(assembly(pathToFileURL(source).href));
  assert.equal(result.valid, true);
  assert.match(result.xml, /version="1\.10"/);
  assert.match(result.xml, /offset="1001\/1000s"/);
  assert.match(result.xml, /start="1001\/2000s"/);
  assert.match(result.xml, /Hero &amp; Product/);
  assert.equal(result.manifest.clips[0].sourceSha256, 'a'.repeat(64));
  assert.equal(result.manifest.clips[0].rightsStatus, 'approved');
}));

test('requires explicit asset root for relative paths and rejects path traversal', async () => fixture(async root => {
  const source = path.join(root, 'hero.mp4');
  await writeFile(source, 'media');
  const missingRoot = await exportPremiereInterchange(assembly('hero.mp4'));
  assert.equal(missingRoot.valid, false);
  const traversal = await exportPremiereInterchange(assembly('../outside.mp4'), { assetRoot: root });
  assert.equal(traversal.valid, false);
  assert.ok(traversal.issues.some(item => item.code === 'MEDIA_SOURCE_UNRESOLVED'));
}));

test('fails closed when media checksum or source file is unresolved', async () => fixture(async root => {
  const noHash = await exportPremiereInterchange(assembly('file:///missing.mp4', 'bad'));
  assert.equal(noHash.valid, false);
  const noSource = await exportPremiereInterchange(assembly('file:///missing.mp4'));
  assert.equal(noSource.valid, false);
}));

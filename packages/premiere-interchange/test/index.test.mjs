import test from 'node:test';
import { createHash } from 'node:crypto';
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
  const checksum = createHash('sha256').update('media').digest('hex');
  const result = await exportPremiereInterchange(assembly(pathToFileURL(source).href, checksum));
  assert.equal(result.valid, true);
  assert.match(result.xml, /version="1\.10"/);
  assert.match(result.xml, /offset="1001\/1000s"/);
  assert.match(result.xml, /start="1001\/2000s"/);
  assert.match(result.xml, /Hero &amp; Product/);
  assert.equal(result.manifest.clips[0].sourceSha256, checksum);
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

test('preserves multi-track overlaps, source in-points and exact rational ranges', async () => fixture(async root => {
  const media = {};
  for (const [id, content] of Object.entries({ narration: 'voice', hero: 'hero', insert: 'insert', music: 'music' })) {
    const file = path.join(root, id + '.mov');
    await writeFile(file, content);
    media[id] = { uri: pathToFileURL(file).href, sha256: createHash('sha256').update(content).digest('hex') };
  }
  const input = {
    assemblyVersion: '1.0.0',
    project: { id: 'multi', name: 'Multi-track', frameRate: { numerator: 24000, denominator: 1001 } },
    sequence: { name: 'Multi-track sequence', durationFrames: 240 }, scenes: [{ sceneId: 's1', startFrame: 0, endFrame: 240 }],
    clips: [
      { clipId: 'narration', sceneId: 's1', name: 'Narration', kind: 'audio', track: 'A1', startFrame: 0, endFrame: 240, durationFrames: 240, sourceInFrame: 24, sourceUri: media.narration.uri, sourceSha256: media.narration.sha256, media: true },
      { clipId: 'hero', sceneId: 's1', name: 'Hero', kind: 'video', track: 'V1', startFrame: 0, endFrame: 180, durationFrames: 180, sourceInFrame: 12, sourceUri: media.hero.uri, sourceSha256: media.hero.sha256, media: true },
      { clipId: 'music', sceneId: 's1', name: 'Music', kind: 'audio', track: 'A2', startFrame: 12, endFrame: 240, durationFrames: 228, sourceInFrame: 0, sourceUri: media.music.uri, sourceSha256: media.music.sha256, media: true },
      { clipId: 'insert', sceneId: 's1', name: 'Insert', kind: 'video', track: 'V2', startFrame: 120, endFrame: 240, durationFrames: 120, sourceInFrame: 8, sourceUri: media.insert.uri, sourceSha256: media.insert.sha256, media: true },
      { clipId: 'title', sceneId: 's1', name: 'Title card', kind: 'text', track: 'G1', startFrame: 0, endFrame: 48, durationFrames: 48, sourceInFrame: 0, media: false }
    ]
  };
  const blocked = await exportPremiereInterchange(input, { width: 1920, height: 1080 });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.xml, null);
  const result = await exportPremiereInterchange(input, { width: 1920, height: 1080, allowUnsupportedClips: true });
  assert.equal(result.valid, true);
  const clipRows = [...result.xml.matchAll(/<asset-clip ref="([^"]+)" name="([^"]+)" lane="([^"]+)" offset="([^"]+)" start="([^"]+)" duration="([^"]+)"\/>/g)].map(match => match.slice(1));
  assert.deepEqual(clipRows, [
    ['r2', 'Narration', '1', '0s', '1001/1000s', '1001/100s'],
    ['r3', 'Hero', '3', '0s', '1001/2000s', '3003/400s'],
    ['r4', 'Music', '2', '1001/2000s', '0s', '19019/2000s'],
    ['r5', 'Insert', '4', '1001/200s', '1001/3000s', '1001/200s']
  ]);
  assert.equal(result.manifest.unsupportedClips[0].clipId, 'title');
  assert.ok(result.issues.some(item => item.code === 'UNSUPPORTED_CLIP_KIND' && item.severity === 'warning'));
}));

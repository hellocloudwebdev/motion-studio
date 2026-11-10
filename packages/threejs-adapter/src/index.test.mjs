import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileThreeJsScene, validateThreeJsScene } from './index.mjs';

function project() {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'three-fixture', name: 'Three fixture', objective: 'Test a procedural sphere.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 2 },
    creative: { concept: 'A rotating sphere', audience: 'Test', message: 'Three.js scenes render from explicit IR data.' },
    brand: { colors: { background: '#101820', accent: '#70e0cc' } },
    assets: [],
    scenes: [{ id: 'sphere-scene', name: 'Sphere scene', durationFrames: 60, intent: 'Show a procedural sphere.', layers: [{ id: 'sphere', kind: '3d', engineHint: 'threejs', content: { primitive: 'sphere', material: { color: '#70e0cc' }, position: { x: 0, y: 0, z: 0 }, keyframes: [{ frame: 0, rotation: { x: 0, y: 0, z: 0 } }, { frame: 59, rotation: { x: 0, y: 3, z: 0 } }] } }] }],
    delivery: { targets: [{ id: 'master', format: 'mp4', width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', colorSpace: 'Rec.709', alpha: false }] }
  };
}

test('validates only explicit supported Three.js scene contracts', () => {
  const input = project();
  const valid = validateThreeJsScene(input, 'sphere-scene');
  assert.equal(valid.valid, true);
  assert.equal(valid.scene.objects[0].primitive, 'sphere');
  const unsupported = structuredClone(input);
  unsupported.scenes[0].layers[0].content.primitive = 'model-file';
  assert.equal(validateThreeJsScene(unsupported, 'sphere-scene').valid, false);
  const unresolved = structuredClone(input);
  unresolved.scenes[0].layers[0].assetId = 'unimported-model';
  assert.match(validateThreeJsScene(unresolved, 'sphere-scene').issues[0].message, /asset import is not implemented/);
});

test('compiles a local Three.js project with deterministic frame seeking and no remote scripts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-three-'));
  try {
    const compiled = await compileThreeJsScene(project(), 'sphere-scene', { projectRoot: root });
    const html = await readFile(compiled.htmlPath, 'utf8');
    assert.match(html, /data-composition-id="threejs-sphere-scene"/);
    assert.match(html, /window\.renderAtFrame=renderAtFrame/);
    assert.match(html, /SphereGeometry/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'three.module.js'))).size > 1000);
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'gsap.min.js'))).size > 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

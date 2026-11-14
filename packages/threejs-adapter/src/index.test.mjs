import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileThreeJsScene, renderThreeJsScene, validateThreeJsScene } from './index.mjs';
import { resolveHyperFramesCli } from '../../render-manager/src/index.mjs';

function project({ alpha = false, assets = [], modelLayer = false } = {}) {
  const layers = [{
    id: 'sphere', kind: '3d', engineHint: 'threejs',
    content: { primitive: 'sphere', material: { color: '#70e0cc' }, position: { x: 0, y: 0, z: 0 }, keyframes: [{ frame: 0, rotation: { x: 0, y: 0, z: 0 } }, { frame: 11, rotation: { x: 0, y: 3, z: 0 } }] }
  }];
  if (modelLayer) {
    layers.unshift({ id: 'imported-product', kind: '3d', engineHint: 'threejs', assetId: 'product-model', content: { position: { x: 0, y: -1, z: 0 }, keyframes: [] } });
  }
  return {
    schemaVersion: '1.0.0',
    project: { id: 'three-fixture', name: 'Three fixture', objective: 'Test a procedural sphere.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360 }, totalDurationFrames: 12, colorSpace: 'Rec.709', revision: 2 },
    creative: { concept: 'A rotating sphere', audience: 'Test', message: 'Three.js scenes render from explicit IR data.' },
    brand: { colors: { background: '#101820', accent: '#70e0cc' } },
    assets,
    scenes: [{ id: 'sphere-scene', name: 'Sphere scene', durationFrames: 12, intent: 'Show a procedural sphere.', ...(alpha ? { production: { alpha: true } } : {}), layers }],
    delivery: { targets: [{ id: 'master', format: 'mp4', width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', colorSpace: 'Rec.709', alpha: false }] }
  };
}

test('validates explicit primitives and rejects unsupported contracts', () => {
  const input = project();
  const valid = validateThreeJsScene(input, 'sphere-scene');
  assert.equal(valid.valid, true);
  assert.equal(valid.scene.objects[0].primitive, 'sphere');
  assert.equal(valid.scene.alpha, false);
  const unsupported = structuredClone(input);
  unsupported.scenes[0].layers[0].content.primitive = 'model-file';
  assert.match(validateThreeJsScene(unsupported, 'sphere-scene').issues[0].message, /primitive or a \.glb\/\.gltf/);
});

test('model layers resolve .glb/.gltf assets inside the workspace and fail closed otherwise', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-three-model-'));
  try {
    const modelFile = path.join(root, 'assets', 'product.glb');
    await mkdir0(path.dirname(modelFile));
    await writeFile(modelFile, 'glb-bytes');
    const assets = [{ id: 'product-model', kind: 'model', uri: 'assets/product.glb', rightsStatus: 'user-owned' }];
    const valid = validateThreeJsScene(project({ assets, modelLayer: true }), 'sphere-scene', { sourceRoot: root });
    assert.equal(valid.valid, true);
    assert.equal(valid.scene.objects[0].model.assetId, 'product-model');
    assert.match(valid.scene.objects[0].model.source, /product\.glb$/);

    const missing = project({ assets: [], modelLayer: true });
    assert.match(validateThreeJsScene(missing, 'sphere-scene').issues[0].message, /missing from the Canonical Video IR/);
    const wrongKind = project({ assets: [{ id: 'product-model', kind: 'image', uri: 'assets/product.png' }], modelLayer: true });
    assert.match(validateThreeJsScene(wrongKind, 'sphere-scene', { sourceRoot: root }).issues[0].message, /supports \.glb and \.gltf/);
    const escape = project({ assets: [{ id: 'product-model', kind: 'model', uri: '../outside.glb' }], modelLayer: true });
    assert.match(validateThreeJsScene(escape, 'sphere-scene', { sourceRoot: root }).issues[0].message, /inside the project workspace/);
    const alphaTooLong = project({ alpha: true });
    alphaTooLong.scenes[0].durationFrames = 601;
    alphaTooLong.project.totalDurationFrames = 601;
    assert.match(validateThreeJsScene(alphaTooLong, 'sphere-scene').issues[0].message, /up to 600 frames/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function mkdir0(dir) {
  await mkdir(dir, { recursive: true });
}

test('compiles a local Three.js project with deterministic frame seeking and no remote scripts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-three-'));
  try {
    const compiled = await compileThreeJsScene(project(), 'sphere-scene', { projectRoot: root });
    const html = await readFile(compiled.htmlPath, 'utf8');
    assert.match(html, /data-composition-id="threejs-sphere-scene"/);
    assert.match(html, /window\.renderAtFrame=renderAtFrame/);
    assert.match(html, /SphereGeometry/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.match(html, /importmap/);
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'three.module.js'))).size > 1000);
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'gsap.min.js'))).size > 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('alpha scenes compile a transparent renderer without a scene background', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-three-alpha-'));
  try {
    const compiled = await compileThreeJsScene(project({ alpha: true }), 'sphere-scene', { projectRoot: root });
    const html = await readFile(compiled.htmlPath, 'utf8');
    assert.match(html, /alpha:true/);
    assert.match(html, /setClearColor\(0x000000,0\)/);
    assert.match(html, /background:transparent/);
    assert.doesNotMatch(html, /scene\.background=/, 'alpha scenes must not paint a scene background');
    assert.equal(compiled.spec.alpha, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model layers compile the GLTFLoader and copy the model into composition assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-three-model-compile-'));
  try {
    const modelFile = path.join(root, 'assets', 'product.glb');
    await mkdir0(path.dirname(modelFile));
    await writeFile(modelFile, 'glb-bytes-for-compile');
    const input = project({ assets: [{ id: 'product-model', kind: 'model', uri: 'assets/product.glb', rightsStatus: 'user-owned' }], modelLayer: true });
    const compiled = await compileThreeJsScene(input, 'sphere-scene', { projectRoot: root, sourceRoot: root });
    const html = await readFile(compiled.htmlPath, 'utf8');
    assert.match(html, /GLTFLoader/);
    assert.match(html, /importmap/);
    // The browser spec travels base64-encoded; decode it and pin the relative
    // model path plus the absence of the absolute workspace path.
    const encoded = html.match(/atob\('([^']+)'\)/)?.[1];
    assert.ok(encoded, 'the composition embeds an encoded scene spec');
    const browserSpec = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.equal(browserSpec.objects[0].model.file, './assets/product-model.glb');
    assert.equal(browserSpec.objects[0].model.source, undefined, 'absolute workspace paths never reach the browser');
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'GLTFLoader.js'))).size > 1000);
    assert.ok((await stat(path.join(compiled.outputDir, 'assets', 'product-model.glb'))).size > 0);
    // The compiled spec keeps the workspace path as provenance; the browser
    // spec inside the HTML only carries the relative asset path.
    assert.match(compiled.spec.objects[0].model.source, /product\.glb$/);
    assert.doesNotMatch(html, /glb-bytes-for-compile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Runtime renders need the HyperFrames CLI and a usable headless browser;
// environments without them skip instead of failing the suite (same contract
// as the blender-adapter fixture tests). CI sets MOTION_STUDIO_SKIP_BROWSER_
// TESTS=1 because docs/CI.md scopes browser rendering to developer hosts.
const browserTestsSkipped = process.env.MOTION_STUDIO_SKIP_BROWSER_TESTS === '1';
async function hyperframesToolchainAvailable() {
  if (browserTestsSkipped) return false;
  try { await resolveHyperFramesCli(); return true; }
  catch { return false; }
}

test('alpha scene renders a verified transparent PNG sequence', { skip: await hyperframesToolchainAvailable() ? false : 'HyperFrames browser toolchain is required (CI sets MOTION_STUDIO_SKIP_BROWSER_TESTS=1).' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-three-alpha-render-'));
  try {
    const input = project({ alpha: true });
    input.project.canvas = { width: 320, height: 180 };
    input.delivery.targets[0].width = 320;
    input.delivery.targets[0].height = 180;
    const receipt = await renderThreeJsScene(input, 'sphere-scene', { projectRoot: root, sourceRoot: root, quality: 'draft' });
    assert.equal(receipt.artifact.container, 'png-sequence');
    assert.equal(receipt.artifact.alpha, true);
    assert.equal(receipt.artifact.frameCount, 12);
    assert.equal(receipt.frames.length, 12);
    for (const frame of receipt.frames.slice(0, 2)) {
      const bytes = await readFile(frame);
      assert.equal(bytes[25], 6, 'rendered frames must stay RGBA');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

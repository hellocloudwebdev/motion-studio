import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planEffectCraftScene, renderEffectCraftScene, resolveEffectCraftCommand } from './index.mjs';

function projectFixture({ preset = 'fade-up', assets = [], layers = null } = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'ec-fixture', name: 'EC Fixture', objective: 'Verify the EffectCraft adapter.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 3 },
    creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets,
    scenes: [{
      id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show the message.',
      layers: layers ?? [
        { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
        { id: 'bar', kind: 'shape', transform: { x: 60, y: 120, width: 200, height: 16 }, style: { backgroundColor: '#4ade80' }, motion: { preset, durationFrames: 24 } },
        { id: 'title', kind: 'text', content: { text: 'Motion Studio x EffectCraft' }, typography: { family: 'Arial', sizePx: 42, lineHeight: 1.1, safeArea: true }, transform: { x: 320, y: 200, width: 520, height: 80 }, style: { color: '#ffffff' }, motion: { preset: 'fade', durationFrames: 20 } }
      ]
    }],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 } }] }
  };
}

test('plans a deterministic EffectCraft command script from the IR scene', () => {
  const plan = planEffectCraftScene(projectFixture(), 'scene-01');
  assert.equal(plan.valid, true);
  assert.equal(plan.scene.durationSeconds, 2);
  const ids = plan.steps.map(step => step.id);
  assert.equal(ids[0], 'comp.new');
  assert.equal(ids.filter(id => id === 'layer.newSolid').length, 2, 'both shape layers become solids');
  assert.equal(ids.filter(id => id === 'layer.newText').length, 1);
  assert.deepEqual(plan.skipped, [], 'no skipped layers in the shape/text fixture');
  assert.deepEqual(plan.assetLayers, []);
  // fade-up on the bar: opacity 0→100 and position y+40→y in seconds.
  const barName = plan.steps.find(step => step.id === 'layer.newSolid' && step.params.name.includes('bar')).params.name;
  const barFrames = plan.steps.filter(step => step.id === 'prop.set' && step.params.layer === barName);
  assert.deepEqual(barFrames.map(frame => [frame.params.path, frame.params.time]), [
    ['transform/position', 0],
    ['transform/opacity', 0], ['transform/position', 0],
    ['transform/opacity', 0.8], ['transform/position', 0.8]
  ]);
  assert.deepEqual(barFrames[0].params.value, [160, 128, 0], 'the solid is centered on its IR box');
  assert.deepEqual(barFrames[2].params.value, [160, 168, 0], 'position keyframes are vec3 with the entrance offset');
  assert.deepEqual(barFrames[4].params.value, [160, 128, 0], 'entrance lands on the IR box center (EffectCraft positions solids by center)');
  // Text keyframes: fade 0→100 over 20 frames (0.6667 s).
  const titleName = plan.steps.find(step => step.id === 'layer.newText').params.name;
  const titleOpacity = plan.steps.filter(step => step.id === 'prop.set' && step.params.layer === titleName && step.params.path === 'transform/opacity');
  assert.deepEqual(titleOpacity.map(frame => frame.params.value), [0, 100]);
});

test('plans background-positioned full-canvas solids without a redundant move', () => {
  const plan = planEffectCraftScene(projectFixture(), 'scene-01');
  const bgName = plan.steps.find(step => step.id === 'layer.newSolid').params.name;
  assert.ok(!plan.steps.some(step => step.id === 'prop.set' && step.params.layer === bgName), 'a solid placed at 0,0 needs no position command');
});

test('rejects invalid colors and empty text with explicit issues', () => {
  const broken = projectFixture();
  broken.scenes[0].layers[1].style.backgroundColor = '#12zz34';
  broken.scenes[0].layers[2].content.text = '   ';
  const plan = planEffectCraftScene(broken, 'scene-01');
  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some(issue => issue.code === 'EFFECTCRAFT_COLOR_INVALID'));
  assert.ok(plan.issues.some(issue => issue.code === 'EFFECTCRAFT_TEXT_REQUIRED'));
});

test('IR effects become effect.apply + per-index param steps with camelCase ids', () => {
  const fixture = projectFixture();
  fixture.scenes[0].layers[1].effects = [
    { name: 'Gaussian Blur', params: { Blurriness: 20, 'Repeat Edge': true } },
    { name: 'Tint' }
  ];
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, true);
  const barName = plan.steps.find(step => step.id === 'layer.newSolid' && step.params.name.includes('bar')).params.name;
  const effectSteps = plan.steps.filter(step => step.id === 'effect.apply');
  assert.deepEqual(effectSteps.map(step => step.params.effect), ['Gaussian Blur', 'Tint']);
  assert.deepEqual(effectSteps.map(step => step.params.layers), [[barName], [barName]]);
  const blurParams = plan.steps.filter(step => step.id === 'prop.set' && step.params.path.includes('effects/'));
  assert.deepEqual(blurParams.map(step => step.params.path), ['effects/#1/blurriness', 'effects/#1/repeatEdge'], 'per-layer effect index and camelCase param ids');
  assert.equal(blurParams[0].params.value, 20);
});

test('effects on asset layers are planned into the placement session', () => {
  const fixture = projectFixture({ assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: 'a'.repeat(64) }], layers: [
    { id: 'footage', kind: 'video', assetId: 'clip', transform: { x: 100, y: 90, width: 440, height: 180 }, effects: [{ name: 'Gaussian Blur', params: { Blurriness: 8 } }] }
  ] });
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, true);
  assert.equal(plan.assetLayers.length, 1);
  assert.deepEqual(plan.assetLayers[0].phaseTwoEffects.map(step => step.id), ['effect.apply', 'prop.set']);
  assert.equal(plan.assetLayers[0].phaseTwoEffects[0].params.layers[0], plan.assetLayers[0].name);
});

test('malformed effect entries fail with explicit issues', () => {
  const fixture = projectFixture();
  fixture.scenes[0].layers[1].effects = [{ params: { Blurriness: 5 } }];
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some(issue => issue.code === 'EFFECTCRAFT_EFFECT_NAME_REQUIRED'));
});

test('IR layer.expressions become prop.setExpression steps restricted to transform paths', () => {
  const fixture = projectFixture();
  fixture.scenes[0].layers[1].expressions = [
    { path: 'transform/rotation', expression: 'time*180' },
    { path: 'effects/blur', expression: 'time' },
    { path: 'transform/opacity', expression: ' ' }
  ];
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, false, 'the empty expression and the out-of-namespace path are errors');
  assert.ok(plan.issues.some(issue => issue.code === 'EFFECTCRAFT_EXPRESSION_PATH_UNSUPPORTED'));
  assert.ok(plan.issues.some(issue => issue.code === 'EFFECTCRAFT_EXPRESSION_INVALID'));
  const expressionSteps = plan.steps.filter(step => step.id === 'prop.setExpression');
  assert.deepEqual(expressionSteps.map(step => [step.params.layer, step.params.path, step.params.expression]), [
    ['MS-bar', 'transform/rotation', 'time*180']
  ], 'only the valid transform expression is emitted, addressed to the layer');
});

test('3d layers map to EffectCraft primitives with an advanced3D comp', () => {
  const fixture = projectFixture({ layers: [
    { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
    { id: 'cube', kind: '3d', engineHint: 'effectcraft', content: { primitive: 'box', material: { color: '#4ade80' }, position: { x: 320, y: 180, z: 0 }, depth: 140, metallic: 30, roughness: 40 } },
    { id: 'orb', kind: '3d', engineHint: 'effectcraft', content: { primitive: 'sphere', position: { x: 100, y: 80, z: -50 }, radius: 80 } },
    { id: 'cam', kind: 'camera', content: { preset: '35mm' } }
  ] });
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, true);
  const comp = plan.steps[0];
  assert.equal(comp.params.renderer, 'advanced3D', 'a scene with 3d layers upgrades the renderer');
  const cube = plan.steps.find(step => step.id === 'layer.new3dPrimitive' && step.params.name === 'MS-cube');
  assert.equal(cube.params.kind, 'cube', 'IR box maps to the EffectCraft cube');
  assert.equal(cube.params.baseColor, '#4ade80');
  assert.deepEqual(cube.params.position, [320, 180, 0]);
  assert.equal(cube.params.metallic, 30);
  const orb = plan.steps.find(step => step.id === 'layer.new3dPrimitive' && step.params.name === 'MS-orb');
  assert.equal(orb.params.kind, 'sphere');
  assert.equal(orb.params.radius, 80);
  const camera = plan.steps.find(step => step.id === 'layer.newCamera');
  assert.equal(camera.params.preset, '35mm');
  const unknown = projectFixture({ layers: [{ id: 'weird', kind: '3d', engineHint: 'effectcraft', content: { primitive: 'monolith' } }] });
  const unknownPlan = planEffectCraftScene(unknown, 'scene-01');
  assert.equal(unknownPlan.valid, false);
  assert.ok(unknownPlan.issues.some(issue => issue.code === 'EFFECTCRAFT_PRIMITIVE_UNSUPPORTED'));
});

test('light layers plan to EffectCraft point lights', () => {
  const fixture = projectFixture({ layers: [
    { id: 'l', kind: 'light', content: { kind: 'Spot' } }
  ] });
  const plan = planEffectCraftScene(fixture, 'scene-01');
  assert.equal(plan.valid, true);
  const light = plan.steps.find(step => step.id === 'layer.newLight');
  assert.equal(light.params.kind, 'Spot');
  assert.equal(plan.steps[0].params.renderer, 'advanced3D', 'lights also need the 3D renderer');
});

test('asset layers produce import requests with checksum requirements', () => {
  const good = projectFixture({ assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: 'a'.repeat(64) }], layers: [
    { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
    { id: 'footage', kind: 'video', assetId: 'clip', transform: { x: 100, y: 90, width: 440, height: 180 } }
  ] });
  const plan = planEffectCraftScene(good, 'scene-01');
  assert.equal(plan.valid, true);
  assert.equal(plan.assetLayers.length, 1);
  assert.equal(plan.assetLayers[0].importIndex, 0);
  assert.deepEqual(plan.assetLayers[0].box, { x: 100, y: 90, width: 440, height: 180 });
  assert.equal(plan.steps.some(step => step.id === 'layer.addItem'), false, 'asset placement lives in the driver, not the static plan');
  const missing = projectFixture({ layers: [{ id: 'footage', kind: 'video', assetId: 'ghost', transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  assert.match(planEffectCraftScene(missing, 'scene-01').issues.find(issue => issue.code === 'EFFECTCRAFT_ASSET_MISSING').message, /missing from the Canonical Video IR/);
  const noChecksum = projectFixture({ assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4' }], layers: [{ id: 'footage', kind: 'video', assetId: 'clip', transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  assert.match(planEffectCraftScene(noChecksum, 'scene-01').issues.find(issue => issue.code === 'EFFECTCRAFT_ASSET_CHECKSUM_REQUIRED').message, /sha256/);
});

test('scene-not-found and invalid IR fail closed', () => {
  assert.equal(planEffectCraftScene(projectFixture(), 'missing').valid, false);
  const broken = projectFixture();
  delete broken.project.frameRate.numerator;
  assert.equal(planEffectCraftScene(broken, 'scene-01').valid, false);
});

// Live render: needs the installed effectcraft-cli; skips elsewhere.
async function effectcraftAvailable() {
  try { await resolveEffectCraftCommand(); return true; }
  catch { return false; }
}

test('live render places a real video asset into the comp at the IR box', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-asset-'));
  try {
    await mkdir(path.join(root, 'media'), { recursive: true });
    const clipPath = path.join(root, 'media', 'clip.mp4');
    const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (fixture.status !== 0) throw new Error('ffmpeg fixture failed: ' + fixture.stderr);
    const sha = createHash('sha256').update(await readFile(clipPath)).digest('hex');
    const input = projectFixture({ assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: sha, byteSize: (await stat(clipPath)).size, rightsStatus: 'user-owned' }], layers: [
      { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
      { id: 'footage', kind: 'video', assetId: 'clip', transform: { x: 160, y: 90, width: 320, height: 180 } }
    ] });
    const receipt = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, sourceRoot: root, quality: 'draft' });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.assets.length, 1);
    assert.deepEqual(receipt.assets[0].item, { width: 320, height: 180 }, 'the imported item is probed for scale-to-box');
    assert.equal(receipt.assets[0].box.width, 320);
    assert.ok(existsSync(receipt.ecprojPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render applies IR effects to the rendered layer', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-fx-'));
  try {
    const input = projectFixture();
    input.scenes[0].layers[1].effects = [{ name: 'Gaussian Blur', params: { Blurriness: 20 } }];
    const receipt = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, quality: 'draft' });
    assert.equal(receipt.verified, true);
    // The saved .ecproj carries the effect: read it back through the CLI.
    const command = await resolveEffectCraftCommand();
    const props = spawnSync(command, ['--project', receipt.ecprojPath, 'props', 'scene-01', 'MS-bar', '--flat'], { encoding: 'utf8' });
    assert.match(props.stdout, /effects\/#1\/blurriness\s+scalar\s+20\.0/, 'the effect param persisted at the planned path');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render applies an expression and checkpoints the previous .ecproj', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-expr-'));
  try {
    const input = projectFixture();
    input.scenes[0].layers[1].expressions = [{ path: 'transform/rotation', expression: 'time*180' }];
    const first = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, quality: 'draft' });
    assert.equal(first.verified, true);
    const checkpointDir = path.join(root, 'engines', 'effectcraft', 'scene-01', 'checkpoints');
    assert.equal(existsSync(checkpointDir), false, 'no checkpoint on the first run (nothing to preserve)');
    const second = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, quality: 'draft' });
    assert.equal(second.verified, true);
    assert.equal(existsSync(checkpointDir), true, 'the second run checkpoints the first run\'s .ecproj');
    const checkpoints = (await readdir(checkpointDir)).filter(name => name.endsWith('.ecproj'));
    assert.equal(checkpoints.length, 1);
    const command = await resolveEffectCraftCommand();
    const props = spawnSync(command, ['--project', second.ecprojPath, 'get', 'scene-01', 'MS-bar', 'transform/rotation', '--time', '1'], { encoding: 'utf8' });
    const rotation = Number((props.stdout.match(/-?[\d.]+/) || [])[0]);
    assert.ok(Math.abs(rotation - 180) < 1, 'the time*180 expression evaluates to 180 at t=1 s, got ' + rotation);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render produces a rotating 3D cube verified by FFprobe', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-3d-'));
  try {
    const input = projectFixture({ layers: [
      { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
      { id: 'cube', kind: '3d', engineHint: 'effectcraft', content: { primitive: 'box', material: { color: '#4ade80' }, position: { x: 320, y: 180, z: 0 }, depth: 140, metallic: 30, roughness: 40, keyframes: [] } },
      { id: 'cam', kind: 'camera', content: { preset: '50mm' } }
    ] });
    input.scenes[0].layers[1].content.keyframes = [
      { frame: 0, rotation: { x: 0, y: 0, z: 0 } },
      { frame: 59, rotation: { x: 0, y: 3, z: 0 } }
    ];
    const receipt = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, quality: 'draft' });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.artifact.width, 640);
    assert.ok(Math.abs(receipt.artifact.durationSeconds - 2) <= 1 / 30);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render honors the editorial sourceInFrame via trim + slip', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-trim-'));
  try {
    await mkdir(path.join(root, 'media'), { recursive: true });
    const clipPath = path.join(root, 'media', 'clip.mp4');
    // 6-second source; the IR scene consumes 2 s starting at the 1 s in-point.
    const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (fixture.status !== 0) throw new Error('ffmpeg fixture failed: ' + fixture.stderr);
    const sha = createHash('sha256').update(await readFile(clipPath)).digest('hex');
    const input = projectFixture({ assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: sha, byteSize: (await stat(clipPath)).size, rightsStatus: 'user-owned' }], layers: [
      { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
      { id: 'footage', kind: 'video', assetId: 'clip', sourceInFrame: 30, transform: { x: 160, y: 90, width: 320, height: 180 } }
    ] });
    const receipt = await renderEffectCraftScene(input, 'scene-01', { projectRoot: root, sourceRoot: root, quality: 'draft' });
    assert.equal(receipt.verified, true);
    assert.ok(Math.abs(receipt.artifact.durationSeconds - 2) <= 1 / 30, 'the comp keeps its 2 s duration');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render produces an FFprobe-verified MP4 from the IR scene', { skip: await effectcraftAvailable() ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ec-live-'));
  try {
    const receipt = await renderEffectCraftScene(projectFixture(), 'scene-01', { projectRoot: root, quality: 'draft' });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.artifact.width, 640);
    assert.equal(receipt.artifact.height, 360);
    assert.ok(Math.abs(receipt.artifact.durationSeconds - 2) <= 1 / 30, 'duration matches the IR scene');
    assert.equal(receipt.artifact.frameRate.numerator, 30);
    assert.ok(existsSync(receipt.ecprojPath), 'the scene .ecproj is kept in the workspace');
    assert.deepEqual(receipt.skippedLayers, []);
    const saved = JSON.parse(await readFile(receipt.artifact.path + '.effectcraft.json', 'utf8'));
    assert.equal(saved.engine, 'effectcraft');
    assert.ok((await stat(receipt.artifact.path)).size > 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planEffectCraftScene, renderEffectCraftScene, resolveEffectCraftCommand } from './index.mjs';

function projectFixture({ preset = 'fade-up' } = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'ec-fixture', name: 'EC Fixture', objective: 'Verify the EffectCraft adapter.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 3 },
    creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [],
    scenes: [{
      id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show the message.',
      layers: [
        { id: 'bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
        { id: 'bar', kind: 'shape', transform: { x: 60, y: 120, width: 200, height: 16 }, style: { backgroundColor: '#4ade80' }, motion: { preset, durationFrames: 24 } },
        { id: 'title', kind: 'text', content: { text: 'Motion Studio x EffectCraft' }, typography: { family: 'Arial', sizePx: 42, lineHeight: 1.1, safeArea: true }, transform: { x: 320, y: 200, width: 520, height: 80 }, style: { color: '#ffffff' }, motion: { preset: 'fade', durationFrames: 20 } },
        { id: 'asset-clip', kind: 'video', assetId: 'not-in-scope', transform: { x: 0, y: 0, width: 320, height: 180 } }
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
  // The unsupported video layer is reported, never silently dropped.
  assert.deepEqual(plan.skipped.map(item => item.layerId), ['asset-clip']);
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
    assert.equal(receipt.skippedLayers.length, 1);
    const saved = JSON.parse(await readFile(receipt.artifact.path + '.effectcraft.json', 'utf8'));
    assert.equal(saved.engine, 'effectcraft');
    assert.ok((await stat(receipt.artifact.path)).size > 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

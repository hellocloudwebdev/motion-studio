import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlenderSceneSpec } from './index.mjs';

const project = {
  project: { id: 'fixture', frameRate: { numerator: 30000, denominator: 1001 }, canvas: { width: 1920, height: 1080 } },
  brand: { colors: { primary: '#F5A623' } },
  scenes: []
};
const scene = {
  id: 'product', durationFrames: 60,
  layers: [{ id: 'bottle', kind: '3d', engineHint: 'blender', content: { primitive: 'cylinder', transform: { location: [0, 0, 1], scale: [1, 1, 2] }, keyframes: [{ frame: 0, rotation: [0, 0, 0] }, { frame: 59, rotation: [0, 0, 6.28] }] } }]
};

test('Blender scene contract preserves rational fps, explicit geometry, materials, and integer keyframes', () => {
  const spec = buildBlenderSceneSpec(project, scene, { outputDirectory: 'frames', metadataPath: 'scene.json' });
  assert.equal(spec.fpsNumerator, 30000);
  assert.equal(spec.fpsDenominator, 1001);
  assert.equal(spec.objects[0].primitive, 'cylinder');
  assert.equal(spec.objects[0].color, '#F5A623');
  assert.equal(spec.objects[0].keyframes[1].frame, 59);
  assert.equal(spec.durationFrames, 60);
});

test('Blender refuses implicit placeholder geometry and out-of-range animation frames', () => {
  const noGeometry = structuredClone(scene); delete noGeometry.layers[0].content.primitive;
  assert.throws(() => buildBlenderSceneSpec(project, noGeometry, { outputDirectory: 'frames', metadataPath: 'scene.json' }), /must declare a supported primitive/);
  const badFrame = structuredClone(scene); badFrame.layers[0].content.keyframes[1].frame = 60;
  assert.throws(() => buildBlenderSceneSpec(project, badFrame, { outputDirectory: 'frames', metadataPath: 'scene.json' }), /inside the scene frame range/);
});

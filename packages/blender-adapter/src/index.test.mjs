import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlenderSceneSpec, planBlenderFrameRecovery, renderBlenderFrame, renderBlenderScene } from './index.mjs';

const project = {
  project: { id: 'fixture', frameRate: { numerator: 30000, denominator: 1001 }, canvas: { width: 1920, height: 1080 } },
  brand: { colors: { primary: '#F5A623' } },
  scenes: []
};
const scene = {
  id: 'product', durationFrames: 60,
  layers: [{ id: 'bottle', kind: '3d', engineHint: 'blender', content: { primitive: 'cylinder', transform: { location: [0, 0, 1], scale: [1, 1, 2] }, keyframes: [{ frame: 0, rotation: [0, 0, 0] }, { frame: 59, rotation: [0, 0, 6.28] }] } }]
};
const build = (animatedScene, extra = {}) => buildBlenderSceneSpec(project, animatedScene, { outputDirectory: 'frames', metadataPath: 'scene.json', ...extra });
const buildAsset = (assetSceneVariant, extra = {}) => buildBlenderSceneSpec(assetProject, assetSceneVariant, { outputDirectory: 'frames', metadataPath: 'scene.json', ...extra });
const FIXTURE_ROOT = fileURLToPath(new URL('../../../projects/blender-contract-fixtures', import.meta.url));

test('Blender scene contract preserves rational fps, explicit geometry, materials, and integer keyframes', () => {
  const spec = build(scene);
  assert.equal(spec.fpsNumerator, 30000);
  assert.equal(spec.fpsDenominator, 1001);
  assert.equal(spec.objects[0].primitive, 'cylinder');
  assert.equal(spec.objects[0].color, '#F5A623');
  assert.equal(spec.objects[0].keyframes[1].frame, 59);
  assert.equal(spec.durationFrames, 60);
});

test('Blender refuses implicit placeholder geometry and out-of-range animation frames', () => {
  const noGeometry = structuredClone(scene); delete noGeometry.layers[0].content.primitive;
  assert.throws(() => build(noGeometry), /must declare a supported primitive/);
  const badFrame = structuredClone(scene); badFrame.layers[0].content.keyframes[1].frame = 60;
  assert.throws(() => build(badFrame), /inside the scene frame range/);
});

test('Blender thread cap is validated as a positive integer before any render work', async () => {
  await assert.rejects(() => renderBlenderScene(project, scene, { projectRoot: 'unused', threads: 0 }), /threads must be a positive integer/);
  await assert.rejects(() => renderBlenderScene(project, scene, { projectRoot: 'unused', threads: 1.5 }), /threads must be a positive integer/);
  await assert.rejects(() => renderBlenderScene(project, scene, { projectRoot: 'unused', threads: -2 }), /threads must be a positive integer/);
});

test('Blender camera contract supports integer keyframes and explicit rotation, and rejects unsupported camera fields', () => {
  const animated = structuredClone(scene);
  animated.camera = { location: [0, -8, 2], lens: 40, rotation: [0.1, 0, 0], keyframes: [{ frame: 0, location: [-3, -7, 1.5] }, { frame: 59, location: [3, -7, 2.5] }] };
  const spec = build(animated);
  assert.deepEqual(spec.camera.location, [0, -8, 2]);
  assert.equal(spec.camera.lens, 40);
  assert.deepEqual(spec.camera.rotation, [0.1, 0, 0]);
  assert.deepEqual(spec.camera.keyframes.map(keyframe => keyframe.frame), [0, 59]);
  assert.deepEqual(spec.camera.keyframes[1].location, [3, -7, 2.5]);

  const fov = structuredClone(scene); fov.camera = { fov: 40 };
  assert.throws(() => build(fov), /does not support fov; declare lens/);
  const unknownField = structuredClone(scene); unknownField.camera = { focal: 40 };
  assert.throws(() => build(unknownField), /unsupported fields: focal/);
  const outOfRange = structuredClone(scene); outOfRange.camera = { keyframes: [{ frame: 60, location: [1, 1, 1] }] };
  assert.throws(() => build(outOfRange), /inside the scene frame range/);
  const emptyKeyframe = structuredClone(scene); emptyKeyframe.camera = { keyframes: [{ frame: 3 }] };
  assert.throws(() => build(emptyKeyframe), /must declare location or rotation/);
  const nonObject = structuredClone(scene); nonObject.camera = 12;
  assert.throws(() => build(nonObject), /Scene camera must be an object/);
});

test('Blender lighting overrides validate types, ranges, and unknown fields', () => {
  const lit = structuredClone(scene);
  lit.lighting = { lights: [
    { type: 'area', location: [4, -5, 6], energy: 900, color: '#FFE1B8', size: 4 },
    { type: 'point', location: [-4, -2, 3], energy: 450, size: 1.5 },
    { type: 'sun', location: [0, -10, 10], energy: 3 }
  ] };
  const spec = build(lit);
  assert.equal(spec.lighting.lights.length, 3);
  assert.equal(spec.lighting.lights[0].type, 'area');
  assert.equal(spec.lighting.lights[0].color, '#FFE1B8');
  assert.equal(spec.lighting.lights[0].size, 4);
  assert.equal(spec.lighting.lights[1].size, 1.5);
  assert.ok(!('color' in spec.lighting.lights[1]));
  assert.ok(!('size' in spec.lighting.lights[2]));
  assert.ok(!('color' in spec.lighting.lights[2]));

  const unknownLightingField = structuredClone(scene); unknownLightingField.lighting = { lights: [{ type: 'area', location: [0, 0, 5], energy: 10 }], background: '#000000' };
  assert.throws(() => build(unknownLightingField), /lighting declares unsupported fields: background/);
  const unknownLightField = structuredClone(scene); unknownLightField.lighting = { lights: [{ type: 'area', location: [0, 0, 5], energy: 10, blur: 2 }] };
  assert.throws(() => build(unknownLightField), /Light 1 declares unsupported fields: blur/);
  const badType = structuredClone(scene); badType.lighting = { lights: [{ type: 'spot', location: [0, 0, 5], energy: 10 }] };
  assert.throws(() => build(badType), /unsupported type "spot"/);
  const zeroEnergy = structuredClone(scene); zeroEnergy.lighting = { lights: [{ type: 'area', location: [0, 0, 5], energy: 0 }] };
  assert.throws(() => build(zeroEnergy), /energy must be a finite number/);
  const missingLocation = structuredClone(scene); missingLocation.lighting = { lights: [{ type: 'area', energy: 10 }] };
  assert.throws(() => build(missingLocation), /Light 1 location must have three finite numeric values/);
  const sunSize = structuredClone(scene); sunSize.lighting = { lights: [{ type: 'sun', location: [0, -5, 5], energy: 3, size: 2 }] };
  assert.throws(() => build(sunSize), /sun light; size is unsupported/);
  const hugeSize = structuredClone(scene); hugeSize.lighting = { lights: [{ type: 'area', location: [0, 0, 5], energy: 10, size: 200 }] };
  assert.throws(() => build(hugeSize), /size must be a finite number/);
  const tooMany = structuredClone(scene); tooMany.lighting = { lights: Array.from({ length: 9 }, (_, index) => ({ type: 'area', location: [0, 0, 5], energy: 10, size: 1 + index })) };
  assert.throws(() => build(tooMany), /at most 8 lights/);
  const notAnObject = structuredClone(scene); notAnObject.lighting = ['area'];
  assert.throws(() => build(notAnObject), /Scene lighting must be an object/);
  const emptyRig = structuredClone(scene); emptyRig.lighting = { lights: [] };
  assert.throws(() => build(emptyRig), /non-empty array/);
});

test('Blender material parameters validate ranges and reject unknown material fields', () => {
  const metallic = structuredClone(scene);
  metallic.layers[0].content.material = { metallic: 0.8, roughness: 0.3, emission: 2 };
  const spec = build(metallic);
  assert.deepEqual(spec.objects[0].material, { metallic: 0.8, roughness: 0.3, emission: 2 });

  const roughnessRange = structuredClone(scene); roughnessRange.layers[0].content.material = { roughness: 1.5 };
  assert.throws(() => build(roughnessRange), /material.roughness must be a finite number between 0 and 1/);
  const emissionRange = structuredClone(scene); emissionRange.layers[0].content.material = { emission: -1 };
  assert.throws(() => build(emissionRange), /material.emission must be a finite number between 0 and 10/);
  const unknownParam = structuredClone(scene); unknownParam.layers[0].content.material = { clearcoat: 1 };
  assert.throws(() => build(unknownParam), /material declares unsupported fields: clearcoat/);
  const nonObject = structuredClone(scene); nonObject.layers[0].content.material = 'shiny';
  assert.throws(() => build(nonObject), /material must be an object/);
});

test('Blender keyframe entries reject unsupported fields explicitly', () => {
  const eased = structuredClone(scene);
  eased.layers[0].content.keyframes[0].ease = 'linear';
  assert.throws(() => build(eased), /declares unsupported fields: ease/);
});

const assetProject = {
  project: { id: 'asset-fixture', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 480, height: 270 } },
  assets: [{ id: 'cube-glb', kind: '3d', uri: 'assets/models/reference-cube.glb' }],
  scenes: []
};
const assetScene = {
  id: 'asset-scene', durationFrames: 12,
  layers: [{ id: 'imported', kind: '3d', engineHint: 'blender', assetId: 'cube-glb', content: { color: '#F5A623', transform: { location: [0, 0, 0] }, keyframes: [{ frame: 0, rotation: [0, 0, 0] }, { frame: 11, rotation: [0, 0, 1.5708] }] } }]
};

test('Blender imported assets resolve inside the project with format and color override', () => {
  const spec = buildAsset(structuredClone(assetScene), { projectRoot: FIXTURE_ROOT });
  assert.equal(spec.objects.length, 1);
  assert.equal(spec.objects[0].asset.assetId, 'cube-glb');
  assert.equal(spec.objects[0].asset.uri, 'assets/models/reference-cube.glb');
  assert.equal(spec.objects[0].asset.format, 'gltf');
  assert.equal(spec.objects[0].asset.path, path.resolve(FIXTURE_ROOT, 'assets/models/reference-cube.glb'));
  assert.equal(spec.objects[0].color, '#F5A623');
  assert.deepEqual(spec.objects[0].keyframes[1].rotation, [0, 0, 1.5708]);
  assert.ok(!('primitive' in spec.objects[0]));
});

test('Blender imported assets reject unknown, malformed, unsupported, and escaping references explicitly', () => {
  const withRoot = scene => buildAsset(scene, { projectRoot: FIXTURE_ROOT });
  const withProject = (projectVariant, sceneVariant) => buildBlenderSceneSpec(projectVariant, sceneVariant, { outputDirectory: 'frames', metadataPath: 'scene.json', projectRoot: FIXTURE_ROOT });
  const unknownAsset = structuredClone(assetScene); unknownAsset.layers[0].assetId = 'missing-asset';
  assert.throws(() => withRoot(unknownAsset), /not declared in project\.assets/);
  for (const [uri, pattern] of [
    ['assets/models/cube.fbx', /unsupported imported-asset extension \.fbx/],
    ['C:/shared/cube.glb', /project-relative path without a scheme/],
    ['https://cdn.example.com/cube.glb', /project-relative path without a scheme/],
    ['../outside/cube.glb', /escapes the project root/]
  ]) {
    const variant = structuredClone(assetProject); variant.assets = [{ id: 'cube-glb', uri }];
    assert.throws(() => withProject(variant, assetScene), pattern);
  }
  assert.throws(() => buildAsset(structuredClone(assetScene)), /no projectRoot was provided/);
  const bothGeometry = structuredClone(assetScene); bothGeometry.layers[0].content.primitive = 'cube';
  assert.throws(() => withRoot(bothGeometry), /cannot declare both assetId and a primitive/);
  const materialOverride = structuredClone(assetScene); materialOverride.layers[0].content.material = { metallic: 1 };
  assert.throws(() => withRoot(materialOverride), /color override is supported/);
  const contentAssetId = structuredClone(assetScene); contentAssetId.layers[0].content.assetId = 'cube-glb';
  assert.throws(() => withRoot(contentAssetId), /Declare assetId on the layer itself/);
  const unknownContentField = structuredClone(assetScene); unknownContentField.layers[0].content.typo = true;
  assert.throws(() => withRoot(unknownContentField), /unsupported content fields: typo/);
});

test('Blender outputContract.alpha must be boolean and maps into the spec', () => {
  const alpha = structuredClone(scene); alpha.outputContract = { alpha: true };
  assert.equal(build(alpha).alpha, true);
  const nonBoolean = structuredClone(scene); nonBoolean.outputContract = { alpha: 'yes' };
  assert.throws(() => build(nonBoolean), /outputContract\.alpha must be a boolean/);
  const malformed = structuredClone(scene); malformed.outputContract = 'rect';
  assert.throws(() => build(malformed), /outputContract must be an object/);
});

test('Blender frame recovery planner schedules exactly one retry per missing or empty frame', () => {
  const partial = planBlenderFrameRecovery(3, [{ frame: 0, bytes: 10 }, { frame: 1, bytes: 0 }, { frame: 2, bytes: 20 }]);
  assert.deepEqual(partial.missing, [1]);
  assert.deepEqual(partial.recovered, [0, 2]);
  const sparse = planBlenderFrameRecovery(4, [{ frame: 1, bytes: 5 }]);
  assert.deepEqual(sparse.missing, [0, 2, 3]);
  const complete = planBlenderFrameRecovery(2, [{ frame: 0, bytes: 5 }, { frame: 1, bytes: 6 }]);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.unexpected, []);
  const extra = planBlenderFrameRecovery(2, [{ frame: 0, bytes: 5 }, { frame: 1, bytes: 6 }, { frame: 5, bytes: 1 }]);
  assert.deepEqual(extra.unexpected, [5]);
  assert.throws(() => planBlenderFrameRecovery(0, []), /positive integer/);
  assert.throws(() => planBlenderFrameRecovery(3, 'frames'), /records/);
  assert.throws(() => planBlenderFrameRecovery(3, [{ frame: 1.5, bytes: 4 }]), /records/);
  assert.throws(() => planBlenderFrameRecovery(3, [{ frame: 1 }]), /records/);
});

test('Blender single-frame renders validate frame bounds and thread caps before any work', async () => {
  await assert.rejects(() => renderBlenderFrame(project, scene, { projectRoot: 'unused', frame: 1.5 }), /non-negative integer/);
  await assert.rejects(() => renderBlenderFrame(project, scene, { projectRoot: 'unused', frame: 60 }), /outside the scene duration/);
  await assert.rejects(() => renderBlenderFrame(project, scene, { projectRoot: 'unused', frame: 0, threads: 0 }), /threads must be a positive integer/);
  await assert.rejects(() => renderBlenderFrame(project, scene, { frame: 0 }), /A projectRoot is required/);
});

test('Blender render rejects imported assets missing from disk before spawning Blender', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'blender-adapter-'));
  try {
    await assert.rejects(() => renderBlenderScene(assetProject, assetScene, { projectRoot: tempRoot }), /Imported asset file is missing/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

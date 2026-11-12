import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMixedScenes, validateContiguousSceneTimeline, buildBlenderSegmentPlan } from './mixed-render.mjs';

function plan(sceneId, engines) {
  return { sceneId, tasks: engines.map((engine, index) => ({ taskId: sceneId + ':' + engine + ':' + index, engine, layerIds: ['layer-' + index], sequence: index })) };
}

test('classifies whole-scene engine tasks and rejects mixed-engine scenes for v1', () => {
  const classification = classifyMixedScenes([
    plan('scene-01', ['hyperframes']),
    plan('scene-02', ['blender']),
    plan('scene-03', ['hyperframes'])
  ]);
  assert.deepEqual(classification.hyperframes, ['scene-01', 'scene-03']);
  assert.deepEqual(classification.blender, ['scene-02']);
  assert.deepEqual(classification.unsupported, []);

  const mixed = classifyMixedScenes([plan('scene-02', ['hyperframes', 'blender'])]);
  assert.deepEqual(mixed.hyperframes, []);
  assert.deepEqual(mixed.blender, []);
  assert.deepEqual(mixed.unsupported, [{ sceneId: 'scene-02', reason: 'multi-engine-scene', engines: ['hyperframes', 'blender'] }]);

  const outside = classifyMixedScenes([plan('scene-04', ['threejs']), plan('scene-05', ['ffmpeg']), plan('scene-06', [])]);
  assert.deepEqual(outside.unsupported.map(item => [item.sceneId, item.reason]), [
    ['scene-04', 'engine-unsupported-in-v1'],
    ['scene-05', 'engine-unsupported-in-v1'],
    ['scene-06', 'no-engine-tasks']
  ]);
});

test('assembly v1 requires scenes to tile contiguously from frame 0', () => {
  const timeline = validateContiguousSceneTimeline([
    { id: 'scene-01', durationFrames: 60 },
    { id: 'scene-02', startFrame: 60, durationFrames: 60 },
    { id: 'scene-03', durationFrames: 60 }
  ]);
  assert.deepEqual(timeline, [
    { sceneId: 'scene-01', startFrame: 0, durationFrames: 60 },
    { sceneId: 'scene-02', startFrame: 60, durationFrames: 60 },
    { sceneId: 'scene-03', startFrame: 120, durationFrames: 60 }
  ]);
  assert.throws(() => validateContiguousSceneTimeline([{ id: 'a', durationFrames: 60 }, { id: 'b', durationFrames: 60, startFrame: 90 }]), /gap|offset|contiguous|startFrame 90/);
  assert.throws(() => validateContiguousSceneTimeline([{ id: 'a', durationFrames: 60 }, { id: 'b', durationFrames: 60, startFrame: 30 }]), /startFrame 30/);
  assert.throws(() => validateContiguousSceneTimeline([{ id: 'a', durationFrames: 0 }]), /positive integer durationFrames/);
  assert.throws(() => validateContiguousSceneTimeline([{ durationFrames: 60 }]), /non-empty id/);
  assert.throws(() => validateContiguousSceneTimeline([]), /at least one renderable scene/);
});

test('blender frame sequences encode into deterministic MP4 segments matching the IR contract', () => {
  const plan = buildBlenderSegmentPlan({ framesDirectory: 'engines/blender/scene-02/frames', frameCount: 60, output: 'renders/mixed/segments/scene-02.mp4', fps: { numerator: 30, denominator: 1 } });
  assert.equal(plan.executable, 'ffmpeg');
  assert.ok(Array.isArray(plan.args));
  assert.deepEqual(plan.args.slice(0, 4), ['-hide_banner', '-y', '-framerate', '30']);
  assert.ok(plan.args.includes('-frames:v'));
  assert.ok(plan.args.includes('60'));
  assert.ok(plan.args.includes('-r'));
  assert.ok(plan.args.includes('30'));
  assert.ok(plan.args.join(' ').includes('frame_%04d.png'));
  assert.throws(() => buildBlenderSegmentPlan({ framesDirectory: '', frameCount: 60, output: 'x.mp4', fps: { numerator: 30, denominator: 1 } }), /framesDirectory/);
  assert.throws(() => buildBlenderSegmentPlan({ framesDirectory: 'frames', frameCount: 1.5, output: 'x.mp4', fps: { numerator: 30, denominator: 1 } }), /positive integer/);
  assert.throws(() => buildBlenderSegmentPlan({ framesDirectory: 'frames', frameCount: 60, output: 'x.mp4', fps: { numerator: 30000, denominator: 0 } }), /positive integer rational/);
});

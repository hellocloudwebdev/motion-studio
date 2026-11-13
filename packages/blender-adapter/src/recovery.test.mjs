import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderBlenderFrame, renderBlenderScene } from './index.mjs';
import { blenderToolchainAvailable, removeDirectoryWithRetries } from './test-support.mjs';

// Tiny 320x180 three-frame scene: keeps recovery and abort tests fast on the
// low-power host while still exercising real Blender renders.
const faultProject = {
  project: { id: 'recovery-fixture', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180 } },
  scenes: []
};
const faultScene = {
  id: 'recovering', durationFrames: 3,
  layers: [{ id: 'subject', kind: '3d', engineHint: 'blender', content: { primitive: 'cube', color: '#4ADE80', transform: { location: [0, 0, 0] }, keyframes: [{ frame: 0, rotation: [0, 0, 0] }, { frame: 2, rotation: [0, 0, 0.5] }] } }]
};

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blender-recovery-'));
  try {
    return await run(root);
  } finally {
    await removeDirectoryWithRetries(root);
  }
}

test('aborted Blender renders reject cleanly and leave no verified receipt behind', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  await withTempRoot(async root => {
    const controller = new AbortController();
    let abortRequested = false;
    // A 60s watchdog only guards against a silent Blender; normally the first
    // streamed output line triggers the abort.
    const watchdog = setTimeout(() => controller.abort(), 60000);
    try {
      const renderPromise = renderBlenderScene(faultProject, faultScene, {
        projectRoot: root, signal: controller.signal, threads: 2,
        onLine: () => { if (!abortRequested) { abortRequested = true; controller.abort(); } }
      });
      await assert.rejects(() => renderPromise, /aborted via AbortSignal/);
      // The verified receipt artifact must not exist after an abort; partial
      // PNG frames may remain in the frames directory by design (they are
      // discarded on the next full render of the scene).
      const metadataPath = path.join(root, 'engines', 'blender', faultScene.id, 'scene-output.json');
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });
    } finally {
      clearTimeout(watchdog);
    }
  });
});

test('failed frames recover exactly once via single-frame re-render', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const previousSkip = process.env.MOTION_STUDIO_SKIP_FRAME, previousMode = process.env.MOTION_STUDIO_SKIP_MODE;
  process.env.MOTION_STUDIO_SKIP_FRAME = '1';
  delete process.env.MOTION_STUDIO_SKIP_MODE;
  try {
    await withTempRoot(async root => {
      const receipt = await renderBlenderScene(faultProject, faultScene, { projectRoot: root, threads: 2 });
      assert.equal(receipt.verified, true);
      assert.deepEqual(receipt.retriedFrames, [1]);
      assert.equal(receipt.frameCount, 3);
      assert.ok(receipt.firstFrame.bytes > 0);
      // The exported single-frame recovery primitive restores a deleted frame
      // without re-rendering its siblings.
      const framesDirectory = receipt.framesDirectory;
      await rm(path.join(framesDirectory, 'frame_0000.png'));
      const single = await renderBlenderFrame(faultProject, faultScene, { projectRoot: root, frame: 0, threads: 2 });
      assert.equal(single.verified, true);
      const restored = await stat(path.join(framesDirectory, 'frame_0000.png'));
      assert.ok(restored.isFile() && restored.size > 0);
    });
  } finally {
    if (previousSkip === undefined) delete process.env.MOTION_STUDIO_SKIP_FRAME; else process.env.MOTION_STUDIO_SKIP_FRAME = previousSkip;
    if (previousMode === undefined) delete process.env.MOTION_STUDIO_SKIP_MODE; else process.env.MOTION_STUDIO_SKIP_MODE = previousMode;
  }
});

test('frames that keep failing after the single retry pass reject with the failing frame numbers', async t => {
  if (!(await blenderToolchainAvailable())) return t.skip('Blender toolchain is required.');
  const previousSkip = process.env.MOTION_STUDIO_SKIP_FRAME, previousMode = process.env.MOTION_STUDIO_SKIP_MODE;
  process.env.MOTION_STUDIO_SKIP_FRAME = '2';
  process.env.MOTION_STUDIO_SKIP_MODE = 'always';
  try {
    await withTempRoot(async root => {
      await assert.rejects(() => renderBlenderScene(faultProject, faultScene, { projectRoot: root, threads: 2 }), /recovery pass: frames 2 are still missing or empty/);
    });
  } finally {
    if (previousSkip === undefined) delete process.env.MOTION_STUDIO_SKIP_FRAME; else process.env.MOTION_STUDIO_SKIP_FRAME = previousSkip;
    if (previousMode === undefined) delete process.env.MOTION_STUDIO_SKIP_MODE; else process.env.MOTION_STUDIO_SKIP_MODE = previousMode;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHyperFramesProject, resolveHyperFramesCli } from '../../render-manager/src/index.mjs';

// Segment/full consistency probe (design §8 + open question 1): render a tiny
// two-scene fixture whole, render its second scene standalone through the
// scoped `--composition` path, and compare per-frame perceptual signatures over
// the scene-2 time range. The comparison uses the same 32x18 grayscale mean
// absolute difference metric as comparePerceptualFrames, at a stricter
// threshold: a targeted re-render must reproduce the master's frames, not just
// similar ones. A failure here is a finding against targeted mode — the repair
// loop then degrades to whole-project rerenders (decideRerenderScope fallback).

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SAMPLE_FPS = 5;
const FRAME_BYTES = 32 * 18;

function probeFixture() {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'consistency-probe', name: 'Consistency Probe', objective: 'Verify segment/full frame consistency.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360, safeAreaPercent: 5 }, totalDurationFrames: 120, revision: 1 },
    creative: { concept: 'Two distinct animated cards.', audience: 'Engineers.', message: 'Frames must match across render paths.', visualDirection: 'Flat color fields with large type.' },
    brand: { colors: { background: '#10243a', accent: '#4ade80' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [],
    scenes: [
      {
        id: 'scene-01', name: 'Card one', startFrame: 0, durationFrames: 60, intent: 'Cool background.',
        layers: [
          { id: 'p1-bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#10243a' } },
          { id: 'p1-text', kind: 'text', content: { text: 'CARD ONE' }, typography: { family: 'Arial', sizePx: 64, weight: 800, lineHeight: 1.1, alignment: 'center', safeArea: true }, transform: { x: 100, y: 130, width: 440, height: 100 }, style: { color: '#ffffff', textAlign: 'center' }, motion: { preset: 'float', durationFrames: 30, easing: 'sine.out' } }
        ]
      },
      {
        id: 'scene-02', name: 'Card two', startFrame: 60, durationFrames: 60, intent: 'Warm background.',
        layers: [
          { id: 'p2-bg', kind: 'shape', transform: { x: 0, y: 0, width: 640, height: 360 }, style: { backgroundColor: '#4a1f24' } },
          { id: 'p2-text', kind: 'text', content: { text: 'CARD TWO' }, typography: { family: 'Arial', sizePx: 64, weight: 800, lineHeight: 1.1, alignment: 'center', safeArea: true }, transform: { x: 100, y: 130, width: 440, height: 100 }, style: { color: '#4ade80', textAlign: 'center' }, motion: { preset: 'slide-left', durationFrames: 30, easing: 'sine.out' } }
        ]
      }
    ],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 } }] }
  };
}

function runFfmpeg(args) {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.once('error', error => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }));
    child.once('close', code => resolve({ code, stdout: Buffer.concat(stdout), stderr: '' }));
  });
}

// Perceptual signature of a time window: raw 32x18 gray frames at SAMPLE_FPS.
async function extractPerceptualWindow(input, fromSeconds, toSeconds) {
  const result = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', input, '-ss', fromSeconds.toFixed(3), '-to', toSeconds.toFixed(3), '-vf', 'fps=' + SAMPLE_FPS + ',scale=32:18:flags=area,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  if (result.code !== 0) throw new Error('FFmpeg perceptual extraction failed: ' + result.stderr.slice(-2000));
  return result.stdout;
}

// Same mean absolute pixel difference metric comparePerceptualFrames uses for
// consecutive frames, applied across two streams frame by frame.
function crossStreamDifferences(rawA, rawB) {
  const frameCount = Math.min(Math.floor(rawA.length / FRAME_BYTES), Math.floor(rawB.length / FRAME_BYTES));
  const differences = [];
  for (let i = 0; i < frameCount; i += 1) {
    let total = 0;
    const a = i * FRAME_BYTES, b = i * FRAME_BYTES;
    for (let p = 0; p < FRAME_BYTES; p += 1) total += Math.abs(rawA[a + p] - rawB[b + p]);
    differences.push(total / FRAME_BYTES);
  }
  return differences;
}

test('scene-2 rendered standalone matches the same range of the full master', { timeout: 300000 }, async t => {
  try {
    await resolveHyperFramesCli(MODULE_ROOT);
    const probe = await runFfmpeg(['-version']);
    if (probe.code !== 0) throw new Error('ffmpeg unavailable');
  } catch { t.skip('HyperFrames CLI or FFmpeg is not available on this runner.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-consistency-probe-'));
  try {
    const project = probeFixture();
    await mkdir(path.join(root, 'assets'), { recursive: true });
    const projectFile = path.join(root, 'project.json');
    await writeFile(projectFile, JSON.stringify(project, null, 2) + '\n');
    const shared = {
      projectRoot: root,
      engineRoot: path.join(root, 'engines', 'hyperframes'),
      outputRoot: path.join(root, 'renders'),
      sourceRoot: root,
      installRoot: MODULE_ROOT,
      workers: 1,
      quality: 'draft',
      throwOnQaFailure: false
    };
    const full = await renderHyperFramesProject(project, shared);
    const scoped = await renderHyperFramesProject(project, { ...shared, sceneIds: ['scene-02'], renderLabel: 'probe' });
    assert.equal(full.checks.nonEmpty, true, 'the full master render produced output');
    assert.equal(scoped.checks.nonEmpty, true, 'the scoped render produced output');
    const segment = (scoped.segments || []).find(item => item.sceneId === 'scene-02');
    assert.ok(segment?.output, 'the scoped render produced a scene-02 segment');
    // scene-02 occupies seconds 2..4 of the master and 0..2 of the segment.
    const masterWindow = await extractPerceptualWindow(full.output, 2, 4);
    const segmentWindow = await extractPerceptualWindow(segment.output, 0, 2);
    const differences = crossStreamDifferences(masterWindow, segmentWindow);
    assert.ok(differences.length >= 5, 'sampled ' + differences.length + ' aligned frames for comparison');
    const maxDifference = Math.max(...differences);
    const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    // Stricter than the 1.25 near-duplicate threshold used by QA: aligned
    // frames must be essentially identical, not merely similar.
    assert.ok(maxDifference <= 1.25, 'scene-2 segment diverges from the full master: max mean absolute difference ' + maxDifference.toFixed(3) + ' over ' + differences.length + ' frames (mean ' + meanDifference.toFixed(3) + ', per-frame [' + differences.map(value => value.toFixed(2)).join(', ') + ']) — targeted mode would degrade to whole-project');
    assert.ok(meanDifference <= 0.5, 'scene-2 segment mean difference ' + meanDifference.toFixed(3) + ' exceeds the consistency budget');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}); }
});

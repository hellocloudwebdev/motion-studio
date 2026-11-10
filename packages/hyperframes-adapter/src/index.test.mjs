import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileHyperFramesProject } from './index.mjs';

const project = {
  schemaVersion: '1.0.0',
  project: { id: 'fixture', name: 'Fixture', objective: 'Test compiler', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080 }, totalDurationFrames: 90 },
  creative: { concept: 'Compile test', audience: 'Test', message: 'No mutation' },
  brand: { colors: { background: '#101010' }, fonts: { display: 'Inter' } },
  assets: [],
  scenes: [{ id: 'scene-1', name: 'Opening', intent: 'Title card', durationFrames: 90, layers: [
    { id: 'title', kind: 'text', engineHint: 'hyperframes', content: { text: '<Hello & world>' }, typography: { family: 'Inter', sizePx: 100 }, style: { color: '#ffffff' }, motion: { preset: 'fade-up' } },
    { id: 'external-ae', kind: 'text', engineHint: 'after-effects', content: 'Handled in AE' }
  ] }],
  delivery: { targets: [{ id: 'master', format: 'mp4', width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] }
};

test('compiles IR scene into HyperFrames HTML with exact composition and timeline contract', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-'));
  try {
    const result = await compileHyperFramesProject(project, { outputDir: dir, sourceRoot: process.cwd() });
    assert.equal(result.manifest.scenes.length, 1);
    assert.equal(result.manifest.totalDurationFrames, 90);
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.deepEqual(result.manifest.scenes[0].html, 'scenes/scene-1.html');
    assert.equal((await readFile(path.join(dir, 'index.html'), 'utf8')).match(/data-composition-id=/g)?.length, 1);
    assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /\[data-composition-id\]\{position:relative;overflow:hidden;width:1920px;height:1080px/);
    assert.match(html, /data-composition-id="scene-scene-1"/);
    assert.match(html, /window\.__timelines\[compositionId\]=tl/);
    assert.match(html, /&lt;Hello &amp; world&gt;/);
    assert.ok(result.warnings.some(warning => warning.code === 'NON_HYPERFRAMES_LAYER'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects invalid Canonical Video IR before writing output', async () => {
  const invalid = structuredClone(project);
  invalid.project.frameRate.numerator = 0;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-invalid-'));
  try { await assert.rejects(() => compileHyperFramesProject(invalid, { outputDir: dir }), /invalid Video IR/i); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('compiles chart layers to inline SVG and uses frame-based motion timing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-chart-'));
  try {
    const input = structuredClone(project);
    input.scenes[0].layers = [
      {
        id: 'revenue-chart', kind: 'chart', engineHint: 'hyperframes',
        content: { chartType: 'bar', title: 'Revenue', data: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 18 }] },
        transform: { x: 120, y: 100, width: 1500, height: 800 },
        style: { color: '#ff9900' },
        motion: { preset: 'slide-left', durationFrames: 30, delayFrames: 15, easing: 'power2.out' }
      }
    ];
    const result = await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: process.cwd() });
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.equal(result.warnings.length, 0);
    assert.match(html, /<svg/);
    assert.match(html, /Revenue/);
    assert.match(html, /data-motion-duration="1"/);
    assert.match(html, /data-motion-delay="0.5"/);
    assert.match(html, /data-motion-ease="power2.out"/);
    assert.match(html, /slide-left/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sanitizes untrusted color and style values before emitting inline CSS', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-css-'));
  try {
    const input = structuredClone(project);
    input.scenes[0].layers = [{
      id: 'unsafe-style', kind: 'shape', engineHint: 'hyperframes',
      style: { color: 'red;position:fixed', backgroundColor: 'url(javascript:alert(1))', border: '1px solid #ffffff' }
    }];
    await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: process.cwd() });
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.doesNotMatch(html, /javascript:/);
    assert.doesNotMatch(html, /red;position:fixed/);
    assert.match(html, /color:\s*#ffffff/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reports estimated text overflow and unsafe text bounds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-typography-'));
  try {
    const input = structuredClone(project);
    input.scenes[0].layers = [{
      id: 'long-title', kind: 'text', engineHint: 'hyperframes',
      content: { text: 'A very long headline that cannot fit in this tiny text box' },
      typography: { family: 'Inter', sizePx: 96, maxLines: 1 },
      transform: { x: 0, y: 0, width: 160, height: 48 }
    }];
    const result = await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: process.cwd() });
    assert.ok(result.warnings.some(warning => warning.code === 'TEXT_OVERFLOW_ESTIMATED'));
    assert.ok(result.warnings.some(warning => warning.code === 'TEXT_OUTSIDE_SAFE_AREA'));
    await assert.rejects(
      () => compileHyperFramesProject(input, { outputDir: dir, sourceRoot: process.cwd(), strictTypography: true }),
      /Text overflow estimated/
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

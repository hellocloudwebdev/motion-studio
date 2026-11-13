import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('compiles bounded float motion across a scene duration for visible slow movement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-float-'));
  try {
    const input = structuredClone(project);
    input.scenes[0].layers = [{
      id: 'floating-title', kind: 'text', engineHint: 'hyperframes',
      content: { text: 'A slow, deliberate reveal' },
      typography: { family: 'Inter', sizePx: 100 },
      transform: { x: 200, y: 240, width: 1200, height: 180 },
      motion: { preset: 'float', durationFrames: 24 }
    }];
    await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: process.cwd() });
    const html = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /motion==="float"/);
    assert.match(html, /ease:"sine\.inOut",yoyo:true,repeat:driftIterations-1/);
    assert.match(html, /if\(driftIterations>0\)/);
    assert.match(html, /clipDuration=Math\.max\(duration,Number\(el\.dataset\.duration\|\|duration\)\)/);
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

test('chart layer bound via content.audioEnvelope emits envelope-derived bars', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-src-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-out-'));
  try {
    const envelope = {
      fps: 30, windowFrames: 2, durationFrames: 12,
      windows: [
        { startFrame: 0, endFrame: 2, rmsDb: -60 },
        { startFrame: 2, endFrame: 4, rmsDb: -30 },
        { startFrame: 4, endFrame: 6, rmsDb: -12 },
        { startFrame: 6, endFrame: 8, rmsDb: -24 },
        { startFrame: 8, endFrame: 10, rmsDb: -40 },
        { startFrame: 10, endFrame: 12, rmsDb: -6 }
      ]
    };
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'assets', 'envelope.json'), JSON.stringify(envelope, null, 2), 'utf8');
    const input = structuredClone(project);
    input.assets = [{ id: 'beat-envelope', kind: 'data', uri: 'assets/envelope.json' }];
    input.scenes[0].layers = [{
      id: 'beat-chart', kind: 'chart', engineHint: 'hyperframes',
      content: { audioEnvelope: 'beat-envelope', chartType: 'bar', title: 'Loudness' },
      transform: { x: 120, y: 100, width: 1500, height: 800 }
    }];
    const result = await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: source });
    assert.deepEqual(result.warnings, []);
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.equal((html.match(/<rect /g) || []).length, 6);
    // Bar geometry derives from envelopeToChartData: height = value / max(value) * plotHeight.
    const { envelopeToChartData } = await import('../../ffmpeg/src/audio-reactive.mjs');
    const chart = envelopeToChartData(envelope);
    const maxValue = Math.max(...chart.map(point => point.value));
    const heights = [...html.matchAll(/<rect [^>]*height="([^"]+)"/g)].map(match => Number(match[1]));
    const expected = chart.map(point => Math.abs(point.value) / maxValue * 426);
    assert.equal(heights.length, expected.length);
    heights.forEach((height, index) => assert.ok(Math.abs(height - expected[index]) < 1e-6, 'bar ' + index + ': ' + height + ' vs ' + expected[index]));
    assert.match(html, /Loudness/);
    for (const label of ['0', '2', '4', '6', '8', '10']) assert.match(html, new RegExp('>' + label + '</text>'));
    assert.doesNotMatch(html, /audioEnvelope/);
  } finally { await rm(source, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test('unsupported audioEnvelope declarations warn explicitly and are never silent', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-bad-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-badout-'));
  try {
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'assets', 'broken.json'), '{ not json', 'utf8');
    const input = structuredClone(project);
    // 'ghost-envelope' is deliberately NOT declared, so the layer exercises the
    // undeclared-reference path; 'broken-envelope' is declared but malformed.
    input.assets = [{ id: 'broken-envelope', kind: 'data', uri: 'assets/broken.json' }];
    input.scenes[0].layers = [
      { id: 'missing-env-chart', kind: 'chart', engineHint: 'hyperframes', content: { audioEnvelope: 'ghost-envelope' }, transform: { x: 0, y: 0, width: 800, height: 400 } },
      { id: 'invalid-env-chart', kind: 'chart', engineHint: 'hyperframes', content: { audioEnvelope: 'broken-envelope' }, transform: { x: 0, y: 0, width: 800, height: 400 } },
      { id: 'empty-env-chart', kind: 'chart', engineHint: 'hyperframes', content: { audioEnvelope: '   ' }, transform: { x: 0, y: 0, width: 800, height: 400 } },
      { id: 'text-with-envelope', kind: 'text', engineHint: 'hyperframes', content: { text: 'Title', audioEnvelope: 'ghost-envelope' }, typography: { family: 'Inter', sizePx: 80 } }
    ];
    const result = await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: source });
    const codes = result.warnings.map(warning => warning.code);
    assert.ok(codes.includes('AUDIO_ENVELOPE_NOT_AN_ASSET'));
    assert.ok(codes.includes('AUDIO_ENVELOPE_SOURCE_MISSING'));
    assert.ok(codes.includes('AUDIO_ENVELOPE_INVALID'));
    assert.ok(codes.includes('AUDIO_ENVELOPE_UNSUPPORTED_DECLARATION'));
    assert.ok(codes.includes('AUDIO_ENVELOPE_UNSUPPORTED_LAYER'));
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.doesNotMatch(html, /<svg/);
    assert.match(html, /Title/);
  } finally { await rm(source, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test('audioEnvelope paths that escape the project root fail closed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-escape-'));
  try {
    const input = structuredClone(project);
    input.scenes[0].layers = [{
      id: 'escape-chart', kind: 'chart', engineHint: 'hyperframes',
      content: { audioEnvelope: '../../outside/envelope.json' },
      transform: { x: 0, y: 0, width: 800, height: 400 }
    }];
    await assert.rejects(() => compileHyperFramesProject(input, { outputDir: path.join(dir, 'out'), sourceRoot: path.join(dir, 'src') }), /escapes approved project root/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('envelopes beyond the chart point cap are downsampled with an explicit warning', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-long-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-env-longout-'));
  try {
    const envelope = {
      fps: 30, windowFrames: 1, durationFrames: 120,
      windows: Array.from({ length: 120 }, (_, index) => ({ startFrame: index, endFrame: index + 1, rmsDb: -10 - (index % 7) * 4 }))
    };
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'assets', 'envelope.json'), JSON.stringify(envelope), 'utf8');
    const input = structuredClone(project);
    input.assets = [{ id: 'beat-envelope', kind: 'data', uri: 'assets/envelope.json' }];
    input.scenes[0].layers = [{
      id: 'beat-chart', kind: 'chart', engineHint: 'hyperframes',
      content: { audioEnvelope: 'beat-envelope' },
      transform: { x: 0, y: 0, width: 1500, height: 800 }
    }];
    const result = await compileHyperFramesProject(input, { outputDir: dir, sourceRoot: source });
    assert.ok(result.warnings.some(warning => warning.code === 'AUDIO_ENVELOPE_DOWNSAMPLED' && warning.originalWindows === 120 && warning.emittedWindows === 100));
    const html = await readFile(path.join(dir, 'scenes', 'scene-1.html'), 'utf8');
    assert.equal((html.match(/<rect /g) || []).length, 100);
  } finally { await rm(source, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

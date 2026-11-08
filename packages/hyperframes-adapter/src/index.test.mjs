import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const html = await readFile(path.join(dir, 'scene-sources', 'scene-1.html'), 'utf8');
    assert.match(html, /data-composition-id="scene-scene-1"/);
    assert.match(html, /window\.__timelines\[compositionId\]=tl/);
    assert.match(html, /&lt;Hello &amp; world&gt;/);
    assert.match(html, /z-index:0/);
    assert.equal(result.warnings[0].code, 'NON_HYPERFRAMES_LAYER');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects invalid Canonical Video IR before writing output', async () => {
  const invalid = structuredClone(project);
  invalid.project.frameRate.numerator = 0;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-invalid-'));
  try { await assert.rejects(() => compileHyperFramesProject(invalid, { outputDir: dir }), /invalid Video IR/i); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('removes legacy root-level scene compositions before writing the single HyperFrames entrypoint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-legacy-'));
  try {
    const legacy = path.join(dir, 'scene-1.html');
    await writeFile(legacy, '<div data-composition-id="legacy-scene"></div>');
    await compileHyperFramesProject(project, { outputDir: dir, sourceRoot: process.cwd() });
    await assert.rejects(readFile(legacy, 'utf8'), { code: 'ENOENT' });
    assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /data-composition-id="motion-studio-root"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preserves explicit scene offsets, overlaps, and the project duration', async () => {
  const value = structuredClone(project);
  value.project.totalDurationFrames = 120;
  value.scenes[0].startFrame = 10;
  value.scenes.push({ ...structuredClone(value.scenes[0]), id: 'scene-2', name: 'Overlap', startFrame: 60, durationFrames: 30, layers: [{ ...structuredClone(value.scenes[0].layers[0]), id: 'overlap-title' }] });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-hf-overlap-'));
  try {
    const result = await compileHyperFramesProject(value, { outputDir: dir, sourceRoot: process.cwd() });
    assert.deepEqual(result.manifest.scenes.map(scene => scene.startFrame), [10, 60]);
    assert.equal(result.manifest.totalDurationFrames, 120);
    const html = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /data-start="0\.333333"/);
    assert.match(html, /data-start="2"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

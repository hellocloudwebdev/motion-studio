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
    const html = await readFile(path.join(dir, 'scene-1.html'), 'utf8');
    assert.match(html, /data-composition-id="scene-scene-1"/);
    assert.match(html, /window\.__timelines\[compositionId\]=tl/);
    assert.match(html, /&lt;Hello &amp; world&gt;/);
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

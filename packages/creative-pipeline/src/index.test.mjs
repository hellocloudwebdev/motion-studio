import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateProduction, normalizeIntake } from './index.mjs';
import { compileHyperFramesProject } from '../../hyperframes-adapter/src/index.mjs';

const fixture = {
  brief: { title: 'Ocean Currents', objective: 'Explain the role of ocean currents.', audience: 'Curious adults', purpose: 'Explain', language: 'English', platform: 'youtube', durationSeconds: 45, needsClarification: false, clarifyingQuestions: [], researchNeeded: true, researchQuestions: ['How do ocean currents move heat?'], assumptions: [], requiredClaims: ['Ocean currents transport heat.'], callToAction: 'Explore the ocean.' },
  research: { sources: [{ url: 'https://ocean.example.org/currents', title: 'Ocean Currents', publisher: 'Ocean Institute', summary: 'Currents redistribute heat through the ocean.', usageNotes: 'Facts cited by URL; reuse rights not assessed.' }], claims: [{ text: 'Ocean currents move heat around the planet.', sourceUrls: ['https://ocean.example.org/currents'], confidence: 'high' }], unsupportedClaims: [] },
  direction: { concepts: [{ title: 'The Ocean Conveyor', hook: 'A hidden current connects distant shores.', rationale: 'Makes an abstract system feel connected.', visualApproach: 'Dark ocean field with flowing ribbons.', tone: ['curious','clear'] }, { title: 'Heat on the Move', hook: 'The ocean moves more than water.', rationale: 'Starts with a simple surprise.', visualApproach: 'Warm accents travel over a blue field.', tone: ['warm','educational'] }], selectedConceptIndex: 1, messageHierarchy: ['Ocean currents move heat.', 'This shapes climate patterns.'], pacing: 'Steady and clear.', callToAction: 'Explore the ocean.' },
  script: { segments: [
    { narration: 'The ocean is always moving, even when the surface looks calm. Its currents connect places that seem far apart, carrying energy across an enormous blue landscape.', onScreenText: 'A moving ocean', purpose: 'Open with a simple contrast.', claimTexts: [] },
    { narration: 'Large currents carry warm and cool water across long distances. As the water travels, it moves heat from one region toward another, shaping conditions along the way.', onScreenText: 'Heat travels with water', purpose: 'Explain the mechanism.', claimTexts: ['Ocean currents move heat around the planet.'] },
    { narration: 'That movement helps shape climate far beyond the shoreline. Follow the currents and you can see how one connected ocean influences a much wider world.', onScreenText: 'Currents shape climate', purpose: 'Connect the mechanism to its effect.', claimTexts: [] }
  ], totalWordCount: 80, speakingRateWpm: 107 },
  storyboard: { scenes: [0, 1, 2].map((_, i) => ({ intent: `Beat ${i + 1}`, visualDescription: 'Minimal vector lines illustrate the ocean movement.', composition: 'Large headline above a flowing accent line.', motion: 'Lines drift slowly across frame.', transition: 'Fade through a clean color field.', assetRequirements: [] })) },
  designSystem: { backgroundColor: '#091324', textColor: '#F4F7FB', accentColor: '#72F2C2', displayFont: 'Arial', bodyFont: 'Arial', visualRules: ['Use one focal message per scene.', 'Keep type inside the safe area.'], motionPreset: 'fade-up' }
};

function providerWith(overrides = {}) {
  return { async generateObject({ stage }) { return fixture[stage]; }, async research() { return fixture.research; }, ...overrides };
}

test('normalizes intake to a rational frame rate, canvas and explicit defaults', () => {
  const value = normalizeIntake({ idea: 'Explain a natural phenomenon.' });
  assert.deepEqual(value.requested.frameRate, { numerator: 30, denominator: 1 });
  assert.deepEqual(value.requested.canvas, { width: 1920, height: 1080 });
  assert.equal(value.requested.durationSeconds, 45);
  assert.ok(value.assumptions.length >= 3);
});

test('rejects invalid intake and non-integral total frame timing', () => {
  assert.throws(() => normalizeIntake({ idea: 'x', options: { durationSeconds: 10 } }), /between 15 and 180/);
  assert.throws(() => normalizeIntake({ idea: 'x', options: { durationSeconds: 15, fpsNumerator: 30000, fpsDenominator: 1001 } }), /integer frame count/);
});

test('preserves supplied assets and references with unknown rights while rejecting unsafe paths', () => {
  const result = normalizeIntake({ idea: 'Explain the supplied product.', options: { suppliedAssets: [{ id: 'logo', kind: 'image', uri: 'assets/logo.png' }], references: ['https://example.com/reference'] } });
  assert.equal(result.requested.suppliedAssets[0].rightsStatus, 'unknown');
  assert.deepEqual(result.requested.references, ['https://example.com/reference']);
  assert.throws(() => normalizeIntake({ idea: 'x', options: { suppliedAssets: [{ id: 'logo', kind: 'image', uri: '../logo.png' }] } }), /project-relative URI/);
  assert.throws(() => normalizeIntake({ idea: 'x', options: { suppliedAssets: [{ id: 'logo', kind: 'image', uri: 'C:\\logo.png' }] } }), /project-relative URI/);
});

test('generates evidence-linked production packet and validated Canonical Video IR', async () => {
  const result = await generateProduction(providerWith(), { idea: 'Explain how ocean currents move heat.', options: { durationSeconds: 45, audience: 'Curious adults' } }, { clock: () => new Date('2026-11-09T00:00:00.000Z') });
  assert.equal(result.status, 'planned');
  assert.equal(result.validation.valid, true);
  assert.equal(result.project.project.totalDurationFrames, 1350);
  assert.equal(result.project.scenes.length, 3);
  assert.equal(result.project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0), 1350);
  assert.ok(result.project.scenes[1].production.sourceClaimIds.includes('claim-001'));
  assert.ok(result.project.captions.every(caption => caption.endFrame > caption.startFrame));
  assert.equal(result.acceptance.narratedProductionAccepted, false);
});

test('generated Video IR compiles through the existing HyperFrames adapter', async () => {
  const result = await generateProduction(providerWith(), { idea: 'Explain how ocean currents move heat.' });
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-creative-'));
  try {
    const compiled = await compileHyperFramesProject(result.project, { outputDir, sourceRoot: outputDir });
    const html = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    assert.equal(compiled.manifest.scenes.length, 3);
    assert.deepEqual(compiled.warnings, []);
    assert.match(html, /scene-01-headline/);
    assert.match(html, /scene-03-headline/);
  } finally {
    const tempRoot = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
    const resolved = path.resolve(outputDir).toLowerCase();
    assert.ok(resolved.startsWith(tempRoot), 'Temporary build output must stay inside the system temp directory.');
    await rm(resolved, { recursive: true, force: true });
  }
});

test('blocks research claims without source URLs and requires a research provider for factual ideas', async () => {
  const noResearch = providerWith({ async research() { return { ...fixture.research, claims: [{ text: 'Unsupported', sourceUrls: [], confidence: 'high' }] }; } });
  await assert.rejects(generateProduction(noResearch, { idea: 'Explain ocean current climate statistics.' }), /no resolvable source/);
  await assert.rejects(generateProduction({ generateObject: async ({ stage }) => fixture[stage] }, { idea: 'Explain ocean current climate statistics.' }), /no research provider/);
});

test('blocks scripts that do not fit the requested spoken duration', async () => {
  const provider = providerWith({ async generateObject({ stage }) {
    if (stage === 'script') return { ...fixture.script, segments: fixture.script.segments.map(item => ({ ...item, narration: item.narration.slice(0, 5) })) };
    return fixture[stage];
  } });
  await assert.rejects(generateProduction(provider, { idea: 'Explain an ocean.' }), /Every script segment needs spoken narration|outside the supported/);
});

test('asks only necessary intake clarifications before researching or writing', async () => {
  let laterStageCalled = false;
  const provider = providerWith({ async generateObject({ stage }) { if (stage !== 'brief') laterStageCalled = true; return { ...fixture[stage], ...(stage === 'brief' ? { needsClarification: true, clarifyingQuestions: ['Which product should this explain?'] } : {}) }; } });
  const result = await generateProduction(provider, { idea: 'Make an explainer about our product.' });
  assert.equal(result.status, 'needs-input');
  assert.deepEqual(result.questions, ['Which product should this explain?']);
  assert.equal(laterStageCalled, false);
});

test('rejects script claims that are not tied to the research evidence set', async () => {
  const provider = providerWith({ async generateObject({ stage }) {
    if (stage === 'script') return { ...fixture.script, segments: fixture.script.segments.map((item, index) => index === 0 ? { ...item, claimTexts: ['Ocean currents cause all weather.'] } : item) };
    return fixture[stage];
  } });
  await assert.rejects(generateProduction(provider, { idea: 'Explain ocean current climate facts.' }), /not linked to researched evidence/);
});

test('OpenRouter provider requires protected key and defaults to free routing', async () => {
  const { createOpenRouterProvider, CREATIVE_SCHEMAS } = await import('./index.mjs');
  assert.throws(() => createOpenRouterProvider({ apiKey: '' }), /OPENROUTER_API_KEY/);
  let requestBody;
  const provider = createOpenRouterProvider({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(options.headers.authorization, 'Bearer test-only');
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(fixture.brief) }), { status: 200 });
  } });
  assert.deepEqual(await provider.generateObject({ stage: 'brief', instructions: 'test', input: {}, schema: CREATIVE_SCHEMAS.brief }), fixture.brief);
  assert.equal(requestBody.model, 'openrouter/free');
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
});

test('OpenRouter research requires paid-search opt in and trusts returned URL citations', async () => {
  const { createOpenRouterProvider, CREATIVE_SCHEMAS } = await import('./index.mjs');
  const disabled = createOpenRouterProvider({ apiKey: 'test-only', fetchImpl: async () => { throw new Error('should not call network'); } });
  await assert.rejects(disabled.research({ brief: {}, queries: [], instructions: 'test', schema: CREATIVE_SCHEMAS.research }), /may incur a separate provider charge/);
  let requestBody;
  const provider = createOpenRouterProvider({ apiKey: 'test-only', enableWebSearch: true, fetchImpl: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
    status: 'completed', output_text: JSON.stringify(fixture.research), output: [{ type: 'message', content: [{ type: 'output_text', annotations: [{ type: 'url_citation', url: 'https://ocean.example.org/currents' }] }] }]
    }), { status: 200 });
  } });
  const result = await provider.research({ brief: {}, queries: [], instructions: 'test', schema: CREATIVE_SCHEMAS.research });
  assert.equal(requestBody.tools[0].type, 'openrouter:web_search');
  assert.equal(result.sources.length, 1);
  assert.equal(result.claims[0].sourceUrls[0], 'https://ocean.example.org/currents');
});

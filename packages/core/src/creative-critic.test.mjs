import test from 'node:test';
import assert from 'node:assert/strict';
import { runCreativeCritique, heuristicCreativeCritique, CREATIVE_DIMENSIONS, REPAIRABLE_CREATIVE_CODES } from './creative-critic.mjs';

function projectFixture(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'critique-fixture', name: 'Critique Fixture', objective: 'Show homeowners where their power goes.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080, safeAreaPercent: 5 }, totalDurationFrames: 120, revision: 1 },
    creative: { concept: 'Invisible household energy becomes visible.', audience: 'Homeowners.', message: 'See where your power goes', visualDirection: 'Dark teal with bright accents.' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [],
    scenes: [
      {
        id: 'scene-01', name: 'Hook', startFrame: 0, durationFrames: 60, intent: 'Stop the scroll.',
        layers: [
          { id: 's1-bg', kind: 'shape', transform: { x: 0, y: 0, width: 1920, height: 1080 }, style: { backgroundColor: '#10243a' } },
          { id: 's1-title', kind: 'text', content: { text: 'See where your power goes today' }, typography: { family: 'Arial', sizePx: 96, lineHeight: 1.1, safeArea: true }, transform: { x: 140, y: 280, width: 1200, height: 240 }, style: { color: '#ffffff' }, motion: { preset: 'float', durationFrames: 24 } }
        ],
        production: { narration: 'See where your power goes, room by room, live.' }
      },
      {
        id: 'scene-02', name: 'CTA', startFrame: 60, durationFrames: 60, intent: 'Convert.',
        layers: [
          { id: 's2-bg', kind: 'shape', transform: { x: 0, y: 0, width: 1920, height: 1080 }, style: { backgroundColor: '#10243a' } },
          { id: 's2-title', kind: 'text', content: { text: 'Get your energy report today' }, typography: { family: 'Arial', sizePx: 84, lineHeight: 1.1, safeArea: true }, transform: { x: 140, y: 280, width: 1200, height: 240 }, style: { color: '#ffffff' }, motion: { preset: 'float', durationFrames: 24 } }
        ],
        production: { narration: 'Visit the report page and get your home energy breakdown now.' }
      }
    ],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] },
    ...overrides
  };
}

test('heuristic critique passes a brand-consistent, on-message project', () => {
  const result = heuristicCreativeCritique({ project: projectFixture() });
  assert.equal(result.provider, 'deterministic-heuristics');
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.findings, []);
});

test('heuristic critique flags a font outside the declared brand as a repairable consistency finding', () => {
  const project = projectFixture();
  project.scenes[1].layers[1].typography.family = 'Comic Sans MS';
  const result = heuristicCreativeCritique({ project });
  const finding = result.findings.find(item => item.repairHint?.defectCode === 'CREATIVE_TYPOGRAPHY_INCONSISTENT');
  assert.ok(finding, 'expected a typography inconsistency finding');
  assert.equal(result.verdict, 'review');
  assert.equal(finding.dimension, 'art-direction');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.evidence.sceneId, 'scene-02');
  assert.equal(finding.evidence.frameAtSeconds, 2);
  assert.equal(finding.advisoryOnly, true);
});

test('heuristic critique flags a missing declared motion preset as repairable', () => {
  const project = projectFixture();
  project.production = { designSystem: { motionPreset: 'fade' } };
  delete project.scenes[0].layers[1].motion;
  const result = heuristicCreativeCritique({ project });
  const finding = result.findings.find(item => item.repairHint?.defectCode === 'CREATIVE_MOTION_PRESET_MISSING');
  assert.ok(finding, 'expected a motion preset finding');
  assert.equal(finding.evidence.layerId, 's1-title');
});

test('heuristic critique keeps subjective findings hint-free', () => {
  const project = projectFixture();
  project.scenes[1].production.narration = 'Completely unrelated words about cooking pasta and sauces tonight';
  project.scenes[0].layers[1].content.text = 'Look';
  project.scenes[0].production.narration = 'Hmm.';
  const result = heuristicCreativeCritique({ project });
  assert.equal(result.verdict, 'review');
  const dimensions = new Set(result.findings.map(item => item.dimension));
  assert.ok(dimensions.has('brief-alignment'), 'expected an off-message finding');
  assert.ok(dimensions.has('hook'), 'expected a thin-hook finding');
  for (const finding of result.findings) {
    assert.equal(finding.repairHint, null, 'subjective findings must not carry repair hints');
    assert.equal(finding.advisoryOnly, true);
  }
});

test('heuristic critique covers pacing, continuity and cta dimensions', () => {
  const project = projectFixture();
  project.scenes[0].durationFrames = 20; // too short (< 1.2 s at 30 fps)
  project.scenes[1].durationFrames = 400; // too long (> 12 s)
  project.scenes[1].layers[0].style.backgroundColor = '#223344';
  project.scenes[1].layers[1].motion.preset = 'zoom';
  const result = heuristicCreativeCritique({ project });
  const dimensions = new Set(result.findings.map(item => item.dimension));
  assert.ok(dimensions.has('pacing'));
  assert.ok(dimensions.has('continuity'));
  for (const finding of result.findings) {
    assert.ok(CREATIVE_DIMENSIONS.has(finding.dimension));
    assert.ok(['low', 'medium'].includes(finding.severity), 'creative findings never exceed medium severity');
  }
});

test('cta finding fires only when the brief objective implies an action', () => {
  const withAction = projectFixture();
  withAction.project.objective = 'Get homeowners to visit the report page.';
  withAction.scenes[1].layers[1].content.text = 'Your energy, room by room';
  withAction.scenes[1].production.narration = 'The report shows monthly totals for every room in the house.';
  const resultAction = heuristicCreativeCritique({ project: withAction });
  assert.ok(resultAction.findings.some(item => item.dimension === 'cta'), 'objective implies action verbs missing in the closing scene');
  const withoutAction = projectFixture();
  withoutAction.project.objective = 'Explain household energy consumption calmly.';
  const resultNone = heuristicCreativeCritique({ project: withoutAction });
  assert.ok(!resultNone.findings.some(item => item.dimension === 'cta'));
});

test('runCreativeCritique caps severity and rejects unknown dimensions and empty summaries', async () => {
  const result = await runCreativeCritique({
    provider: async () => ({
      provider: 'stub',
      verdict: 'pass',
      findings: [
        { dimension: 'pacing', severity: 'critical', summary: 'Model wanted to block; the cap forbids it.', sceneId: 'scene-01' },
        { dimension: 'hook', severity: 'low', summary: 'Opening is thin.', repairHint: { defectCode: 'CREATIVE_TYPOGRAPHY_INCONSISTENT' } }
      ]
    }),
    project: projectFixture()
  });
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.canOverrideDeterministicGates, false);
  assert.equal(result.verdict, 'review', 'a pass verdict with findings downgrades to review');
  assert.equal(result.findings[0].severity, 'medium', 'model severities are capped at medium');
  assert.equal(result.findings[1].repairHint, null, 'hook findings cannot request consistency repairs');
  await assert.rejects(() => runCreativeCritique({
    provider: async () => ({ verdict: 'review', findings: [{ dimension: 'flavor', severity: 'low', summary: 'unknown dimension' }] }),
    project: projectFixture()
  }), /unknown dimension/);
  await assert.rejects(() => runCreativeCritique({
    provider: async () => ({ verdict: 'review', findings: [{ dimension: 'pacing', severity: 'low' }] }),
    project: projectFixture()
  }), /without a summary/);
  await assert.rejects(() => runCreativeCritique({ provider: 'nope', project: projectFixture() }), /opt-in/);
  await assert.rejects(() => runCreativeCritique({
    provider: async () => ({ verdict: 'excellent', findings: [] }),
    project: projectFixture()
  }), /invalid verdict/);
});

test('runCreativeCritique strips repair hints whose defect code has no registered repair op', async () => {
  const result = await runCreativeCritique({
    provider: async () => ({
      verdict: 'review',
      findings: [{ dimension: 'art-direction', severity: 'medium', summary: 'Wrong font.', sceneId: 'scene-01', repairHint: { defectCode: 'TOTALLY_UNREGISTERED_CODE' } }]
    }),
    project: projectFixture()
  });
  assert.equal(result.findings[0].repairHint, null);
  assert.ok(!REPAIRABLE_CREATIVE_CODES.has('TOTALLY_UNREGISTERED_CODE'));
});

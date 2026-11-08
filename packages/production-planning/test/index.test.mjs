import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProductionBrief, validateProductionBrief, buildCreativeWorkflow, summarizeProductionIntake
} from '../src/index.mjs';

test('creates a stable, normalized brief without inventing missing information', () => {
  const a = createProductionBrief({ idea: '  Launch a new coffee app  ' });
  const b = createProductionBrief({ idea: 'Launch a new coffee app' });
  assert.equal(a.idea, 'Launch a new coffee app');
  assert.equal(a.id, b.id);
  assert.equal(a.audience, null);
  assert.equal(a.openQuestions.length, 6);
  assert.equal(a.openQuestions.every(x => x.blocking === false), true);
});

test('preserves optional production constraints and supplied assets', () => {
  const brief = createProductionBrief({
    idea: 'Explain renewable energy',
    audience: 'High school students',
    purpose: 'Education',
    durationSeconds: 90,
    language: 'English',
    platform: 'YouTube',
    aspectRatio: '16:9',
    constraints: ['No stock footage'],
    references: ['https://example.com/reference'],
    suppliedAssets: [{ id: 'logo', uri: 'file:///project/logo.svg' }]
  });
  assert.equal(brief.durationSeconds, 90);
  assert.deepEqual(brief.constraints, ['No stock footage']);
  assert.equal(brief.suppliedAssets[0].id, 'logo');
  assert.equal(brief.openQuestions.length, 0);
});

test('rejects missing ideas and malformed input', () => {
  assert.throws(() => createProductionBrief({ idea: '  ' }), /video idea is required/);
  assert.throws(() => createProductionBrief(null), /JSON object/);
});

test('validates duration and aspect ratio bounds', () => {
  const base = createProductionBrief({ idea: 'Test' });
  assert.equal(validateProductionBrief({ ...base, durationSeconds: 0 }).valid, false);
  assert.equal(validateProductionBrief({ ...base, durationSeconds: 4000 }).valid, false);
  assert.equal(validateProductionBrief({ ...base, aspectRatio: '3:2' }).valid, false);
});

test('requires explicit dimensions for custom aspect ratios', () => {
  const brief = createProductionBrief({ idea: 'Test' });
  const result = validateProductionBrief({ ...brief, aspectRatio: 'custom' });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(x => x.code === 'CUSTOM_DIMENSIONS_REQUIRED'));
});

test('builds a sequential, provider-neutral creative DAG', () => {
  const brief = createProductionBrief({ idea: 'Product explainer' });
  const workflow = buildCreativeWorkflow(brief);
  assert.deepEqual(workflow.stages.map(x => x.id), [
    'creative-direction', 'script', 'storyboard', 'design-system', 'canonical-ir'
  ]);
  assert.deepEqual(workflow.stages.at(-1).dependsOn, ['storyboard', 'design-system']);
  assert.equal(workflow.executionPolicy.providerNeutral, true);
});

test('inserts research only when the brief explicitly requires it', () => {
  const brief = createProductionBrief({ idea: 'Explain a scientific discovery', researchRequired: true, researchReason: 'Claims need citations' });
  const workflow = buildCreativeWorkflow(brief);
  assert.equal(workflow.stages[0].id, 'research');
  assert.deepEqual(workflow.stages[1].dependsOn, ['research']);
});

test('intake summary distinguishes validity from unanswered optional questions', () => {
  const brief = createProductionBrief({ idea: 'A short brand film' });
  const summary = summarizeProductionIntake(brief);
  assert.equal(summary.valid, true);
  assert.equal(summary.readyForCreativePlanning, true);
  assert.equal(summary.openQuestions.length, 6);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProductionBrief, validatePlanningArtifacts, validateResearchEvidence, compilePlanningArtifacts
} from '../src/index.mjs';

function fixture(overrides = {}) {
  const brief = createProductionBrief({
    idea: 'Explain a new productivity app',
    audience: 'Independent creators',
    purpose: 'Introduce the product',
    durationSeconds: 30,
    language: 'English',
    platform: 'YouTube',
    aspectRatio: '16:9'
  });
  const planning = {
    brief,
    creativeDirection: {
      concept: 'Make focused work feel achievable',
      message: 'One workspace for creative work',
      mood: ['confident', 'clear'],
      visualDirection: 'Warm editorial typography with restrained motion'
    },
    script: {
      narration: 'Bring your ideas, tasks and projects into one focused workspace.',
      onScreenCopy: ['Make space for your best work'],
      cta: 'Start creating'
    },
    storyboard: {
      scenes: [{
        id: 'scene-001',
        name: 'Opening',
        intent: 'Introduce the core message',
        durationFrames: 900,
        layers: [{
          id: 'headline',
          kind: 'text',
          engineHint: 'hyperframes',
          content: { text: 'Make space for your best work' },
          typography: { family: 'Inter', sizePx: 96, weight: 700, alignment: 'center' },
          startFrame: 0,
          durationFrames: 900
        }]
      }]
    },
    designSystem: {
      colors: { background: '#101010', foreground: '#ffffff', accent: '#ffb44a' },
      fonts: [{ family: 'Inter', weight: 700, source: 'local' }],
      safeAreaPercent: 5
    },
    ...overrides
  };
  return planning;
}

test('validates planning artifacts and compiles a canonical IR project', () => {
  const result = compilePlanningArtifacts(fixture());
  assert.equal(result.validation.valid, true);
  assert.equal(result.project.scenes.length, 1);
  assert.equal(result.project.project.totalDurationFrames, 900);
  assert.equal(result.project.delivery.targets[0].width, 1920);
  assert.equal(result.project.scenes[0].layers[0].content.text, 'Make space for your best work');
});

test('requires audience, duration and aspect ratio to be resolved before compilation', () => {
  const planning = fixture();
  planning.brief.audience = null;
  planning.brief.durationSeconds = null;
  planning.brief.aspectRatio = null;
  const result = validatePlanningArtifacts(planning);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.filter(x => x.code.startsWith('BRIEF_')).map(x => x.code), [
    'BRIEF_AUDIENCE_UNRESOLVED', 'BRIEF_DURATION_UNRESOLVED', 'BRIEF_ASPECT_UNRESOLVED'
  ]);
});

test('research-required briefs require claim-level source evidence', () => {
  const planning = fixture();
  planning.brief.research.required = true;
  assert.equal(validatePlanningArtifacts(planning).valid, false);
  planning.researchEvidence = {
    schemaVersion: '1.0.0',
    sources: [{ id: 'src-1', title: 'Product report', url: 'https://example.com/report' }],
    claims: [{ id: 'claim-1', text: 'The market grew', sourceIds: ['src-1'] }]
  };
  assert.equal(validatePlanningArtifacts(planning).valid, true);
});

test('research evidence rejects claims with missing or invalid sources', () => {
  const result = validateResearchEvidence({
    schemaVersion: '1.0.0',
    sources: [{ id: 'src-1', title: 'Example', url: 'file:///private/report' }],
    claims: [{ id: 'claim-1', text: 'Unsupported statement', sourceIds: ['missing'] }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(x => x.code === 'RESEARCH_SOURCE_URL'));
  assert.ok(result.issues.some(x => x.code === 'RESEARCH_UNSUPPORTED_CLAIM'));
});

test('compiler rejects storyboard duration drift rather than silently retiming', () => {
  const planning = fixture();
  planning.storyboard.scenes[0].durationFrames = 800;
  assert.throws(() => compilePlanningArtifacts(planning), /must match target duration/);
});

test('compiler supports custom dimensions and rational frame rates', () => {
  const planning = fixture();
  planning.brief.aspectRatio = 'custom';
  planning.brief.customDimensions = { width: 2048, height: 858 };
  planning.brief.frameRate = { numerator: 24000, denominator: 1001 };
  planning.brief.durationSeconds = 37.5375;
  planning.storyboard.scenes[0].durationFrames = 900;
  const result = compilePlanningArtifacts(planning);
  assert.equal(result.project.project.canvas.width, 2048);
  assert.deepEqual(result.project.project.frameRate, { numerator: 24000, denominator: 1001 });
});

test('compiler rejects unsupported frame rates and malformed scene layers', () => {
  const planning = fixture();
  planning.brief.frameRate = { numerator: 29, denominator: 1 };
  assert.throws(() => compilePlanningArtifacts(planning), /Unsupported or invalid frameRate/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { captureProductionLearning, patternToProposalCandidate } from './capture.mjs';
import { createImprovementProposal, evaluateProposal, approveProposal, promoteProposal } from './index.mjs';

function projectFixture({ repairs = [], decisions = [{ type: 'creative-concept-selection', selectedConcept: 'Solar made visible', rationale: 'Concrete visual metaphor' }] } = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'learn-fixture', name: 'Learn Fixture', objective: 'o', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 640, height: 360, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 4, createdAt: '2026-11-17T10:00:00.000Z' },
    creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' }, rules: ['never outline text'] },
    assets: [],
    scenes: [{ id: 'scene-01', name: 'S', startFrame: 0, durationFrames: 60, intent: 'i', layers: [] }],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 } }] },
    provenance: { decisions },
    qa: { repairHistory: repairs }
  };
}

const passedRepair = {
  attempt: 1, runId: 'run-learn', status: 'repair-required', retestResult: 'passed',
  patch: { defectIds: ['TEXT_TOO_SMALL#scene-01#title', 'CONTRAST_LOW#scene-01'], ops: [{ type: 'set_typography' }, { type: 'set_typography' }] }
};

test('capture separates project memory, user preferences and pattern candidates', () => {
  const capture = captureProductionLearning({ project: projectFixture({ repairs: [passedRepair] }), runState: { runId: 'run-learn' } });
  // Project scope carries decisions and repair outcomes.
  assert.equal(capture.scopes.project.decisions.length, 1);
  assert.equal(capture.scopes.project.decisions[0].type, 'creative-concept-selection');
  assert.equal(capture.scopes.project.repairOutcomes.length, 1);
  // User scope carries the declared brand tokens, isolated from project memory.
  assert.equal(capture.scopes.user.scope, 'user');
  assert.deepEqual(capture.scopes.user.colors, { background: '#10243a', accent: '#4ade80', text: '#ffffff' });
  assert.deepEqual(capture.scopes.user.rules, ['never outline text']);
  // Pattern scope holds only the passed repair.
  assert.equal(capture.scopes.patterns.length, 1);
  assert.equal(capture.scopes.patterns[0].kind, 'workflow-documentation');
  assert.equal(capture.counts.candidatePatterns, 1);
});

test('only passed repairs become pattern candidates; failed repairs stay as outcomes', () => {
  const repairs = [
    passedRepair,
    { attempt: 2, status: 'repair-required', retestResult: 'failed', patch: { defectIds: ['X#s'], ops: [{ type: 'set_timing' }] } },
    { attempt: 3, status: 'escalated', retestResult: null }
  ];
  const capture = captureProductionLearning({ project: projectFixture({ repairs }) });
  assert.equal(capture.scopes.project.repairOutcomes.length, 3, 'all outcomes recorded');
  assert.equal(capture.scopes.patterns.length, 1, 'only the passed repair is a candidate');
  assert.match(capture.scopes.patterns[0].title, /TEXT_TOO_SMALL/);
});

test('capture never mutates the IR', () => {
  const project = projectFixture({ repairs: [passedRepair] });
  const before = JSON.stringify(project);
  captureProductionLearning({ project, runState: { runId: 'r' } });
  assert.equal(JSON.stringify(project), before);
});

test('captured patterns flow through the proposal gates without auto-promotion', () => {
  const capture = captureProductionLearning({ project: projectFixture({ repairs: [passedRepair] }) });
  const candidate = capture.scopes.patterns[0];
  const proposalInput = patternToProposalCandidate(candidate);
  const proposal = promoteProposal(
    approveProposal(
      evaluateProposal(createImprovementProposal(proposalInput), { testsPassed: true, regressionPassed: true }),
      { approver: 'producer' }
    ),
    { autoPromoteLowRisk: false }
  );
  assert.equal(proposal.status, 'promoted');
  assert.equal(proposal.history.at(-1).mode, 'approved');
  const autoPromoteBlocked = (() => {
    try { promoteProposal(createImprovementProposal(proposalInput), { autoPromoteLowRisk: false }); return false; }
    catch (error) { return /must pass all evaluation gates|Explicit approval is required/.test(error.message); }
  })();
  assert.equal(autoPromoteBlocked, true, 'promotion without approval stays blocked');
});

test('requires a real IR project', () => {
  assert.throws(() => captureProductionLearning({ project: {} }), /project\.id/);
  assert.throws(() => captureProductionLearning({}), /project\.id/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRetestScope, evaluateRetestScope, failedChecksFromDefects } from './retest-scope.mjs';

const fps = 30;
function projectFixture() {
  return {
    project: { id: 'scope-fixture', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080 }, totalDurationFrames: 120 },
    scenes: [
      { id: 'scene-1', durationFrames: 60 },
      { id: 'scene-2', startFrame: 60, durationFrames: 60 }
    ]
  };
}

test('retest scope reruns failed checks plus the always-on contract checks', () => {
  const defects = [
    { defectId: 'render-1', code: 'CHECK_FAILED_DIMENSIONSMATCH', severity: 'high', sceneId: 'scene-2' },
    { defectId: 'qa-1', code: 'FONT_UNSPECIFIED', severity: 'high', sceneId: 'scene-2' }
  ];
  const scope = computeRetestScope(defects, ['scene-2'], { fps, project: projectFixture() });
  assert.equal(scope.mode, 'targeted');
  assert.deepEqual(scope.sceneIds, ['scene-2']);
  assert.equal(scope.audioSceneIds.length, 0);
  for (const name of ['dimensionsMatch', 'frameRateMatch', 'durationWithinOneFrame', 'hyperFramesCheckPassed', 'mediaAnalysisPassed']) {
    assert.ok(scope.checks.includes(name), name + ' is always retested');
  }
  assert.deepEqual(failedChecksFromDefects(defects), ['dimensionsMatch']);
  assert.deepEqual(failedChecksFromDefects([{ code: 'CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT' }]), ['irSceneDurationMatchesProject']);
  assert.deepEqual(failedChecksFromDefects([{ code: 'CHECK_FAILED_TOTALLYUNKNOWN' }]), []);
});

test('snapshot samples follow the design formula with render-manager clamping', () => {
  const scope = computeRetestScope([{ code: 'FONT_UNSPECIFIED', sceneId: 'scene-2' }], ['scene-2'], { fps, project: projectFixture() });
  // scene-2 spans global frames 60..119; samples: start, midpoint, last frame,
  // plus the start-1 boundary (59) — start+dur (120) is outside the project.
  assert.deepEqual(scope.snapshotTimes.map(sample => sample.frame), [59, 60, 90, 119]);
  const last = scope.snapshotTimes.at(-1);
  // Clamped exactly like render-manager: never past totalSeconds - 1/fps.
  assert.ok(Math.abs(last.atSeconds - (4 - 1 / 30)) < 1e-9);
  assert.ok(Math.abs(last.segmentAtSeconds - (2 - 1 / 30)) < 1e-9);
  const boundary = scope.snapshotTimes.find(sample => sample.frame === 59);
  assert.equal(boundary.sceneId, 'scene-2');
  assert.ok(Math.abs(boundary.atSeconds - 59 / 30) < 1e-9);
  // The scene-local boundary time clamps to the first decodable segment frame.
  assert.equal(boundary.segmentAtSeconds, 0);
  // Clamping behavior stays, but the sample is labeled: it was never decoded at
  // its claimed frame, so the ledger must not claim that coverage.
  assert.equal(boundary.clamped, true);
  for (const frame of [60, 90, 119]) {
    assert.equal(scope.snapshotTimes.find(sample => sample.frame === frame).clamped, false, 'frame ' + frame);
  }
});

test('adjacent boundary samples only appear inside the project', () => {
  const project = { project: { id: 'demo', frameRate: { numerator: 24, denominator: 1 }, totalDurationFrames: 48 }, scenes: [{ id: 'only', durationFrames: 48 }] };
  const scope = computeRetestScope([{ code: 'FONT_UNSPECIFIED', sceneId: 'only' }], ['only'], { fps: 24, project });
  // start-1 (frame -1) and start+dur (frame 48 = totalFrames) are outside.
  assert.deepEqual(scope.snapshotTimes.map(sample => sample.frame), [0, 24, 47]);
});

test('retestRequired defects that the scope cannot cover force full mode', () => {
  const defects = [
    { defectId: 'qa-1', code: 'FONT_UNSPECIFIED', severity: 'high', sceneId: 'scene-2' },
    { defectId: 'render-9', code: 'CHECK_FAILED_HASVIDEO', severity: 'high', sceneId: null, retestRequired: true }
  ];
  const scope = computeRetestScope(defects, ['scene-2'], { fps, project: projectFixture() });
  assert.equal(scope.mode, 'full');
  assert.deepEqual(scope.sceneIds, []);
  assert.deepEqual(scope.uncovered.map(item => item.code), ['CHECK_FAILED_HASVIDEO']);
  assert.match(scope.reason, /CHECK_FAILED_HASVIDEO/);
});

test('policy and missing attribution degrade the scope to full mode', () => {
  const scoped = computeRetestScope([{ code: 'FONT_UNSPECIFIED', sceneId: 'scene-1' }], ['scene-1'], { fps, project: projectFixture(), targetedRerender: false });
  assert.equal(scoped.mode, 'full');
  assert.match(scoped.reason, /policy/);
  const noProject = computeRetestScope([{ code: 'FONT_UNSPECIFIED', sceneId: 'scene-1' }], ['scene-1'], { fps });
  assert.equal(noProject.mode, 'full');
  const empty = computeRetestScope([{ code: 'FONT_UNSPECIFIED', sceneId: null }], [], { fps, project: projectFixture() });
  assert.equal(empty.mode, 'full');
  assert.throws(() => computeRetestScope([], [], { fps: 0, project: projectFixture() }), /positive fps/);
});

test('audio defect scenes are collected for mixed-segment retests', () => {
  const defects = [
    { defectId: 'media-1', code: 'AUDIO_SILENCE_SEGMENT', severity: 'high', sceneId: 'scene-1' },
    { defectId: 'media-2', code: 'AUDIO_PROGRAM_TOO_QUIET', severity: 'high', sceneId: 'scene-2' },
    { defectId: 'qa-1', code: 'FONT_UNSPECIFIED', severity: 'high', sceneId: 'scene-2' }
  ];
  const scope = computeRetestScope(defects, ['scene-1', 'scene-2'], { fps, project: projectFixture() });
  assert.equal(scope.mode, 'targeted');
  assert.deepEqual(scope.audioSceneIds, ['scene-1', 'scene-2']);
});

test('evaluateRetestScope fails on missing checks, audio findings and undecoded samples', () => {
  const scope = { checks: ['dimensionsMatch', 'mediaAnalysisPassed'] };
  const passed = evaluateRetestScope(scope, { checks: { dimensionsMatch: true, mediaAnalysisPassed: true }, audioFindings: [], snapshotEvidence: [{ decoded: true }] });
  assert.equal(passed.passed, true);
  const failed = evaluateRetestScope(scope, {
    checks: { dimensionsMatch: true, mediaAnalysisPassed: false },
    audioFindings: [{ code: 'AUDIO_SILENCE_SEGMENT', message: 'still silent' }],
    snapshotEvidence: [{ sceneId: 'scene-1', frame: 0, decoded: false }]
  });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failures, [
    { type: 'check', name: 'mediaAnalysisPassed', actual: false },
    { type: 'audio', code: 'AUDIO_SILENCE_SEGMENT', message: 'still silent' },
    { type: 'snapshot', sceneId: 'scene-1', frame: 0, atSeconds: null }
  ]);
});

test('clamped boundary samples are recorded but never held against the decode assertions', () => {
  const scope = { checks: [] };
  const result = evaluateRetestScope(scope, { snapshotEvidence: [
    { sceneId: 'scene-2', frame: 59, atSeconds: 59 / 30, decoded: false, clamped: true },
    { sceneId: 'scene-2', frame: 60, atSeconds: 2, decoded: false }
  ] });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ type: 'snapshot', sceneId: 'scene-2', frame: 60, atSeconds: 2 }]);
  const clampedOnly = evaluateRetestScope(scope, { snapshotEvidence: [{ sceneId: 'scene-2', frame: 59, decoded: false, clamped: true }] });
  assert.equal(clampedOnly.passed, true);
});

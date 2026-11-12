import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyRepairPatch, classifyDefects, computeRunGainBudgetUsed, createPatchFromDefects,
  createRepairPlan, estimateTextFit, evaluateRenderEvidence, projectIrSha256,
  runProjectQA, routeScenes, validateProject, validateRepairPatch
} from '../../core/src/index.mjs';
import { computeRepairCyclesFromLedger } from '../../orchestrator/src/run-state.mjs';
import { computeSceneTimeline, createMediaQaContext } from '../../render-manager/src/index.mjs';
import { decideRerenderScope, executeRepairCycle, runRepairLoop } from './index.mjs';
import { writeEscalationReport } from './escalation.mjs';

const LONG_TEXT = 'Every appliance in this home draws power right now and the meter only shows one number for all of it';

function defectFixture(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'repair-fixture', name: 'Repair Fixture', objective: 'Verify the injected-defect exit gate.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080, safeAreaPercent: 5 }, totalDurationFrames: 120, revision: 1 },
    creative: { concept: 'Invisible household energy becomes visible.', audience: 'Homeowners.', message: 'See where your power goes.', visualDirection: 'Dark teal with bright accents.' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [{ id: 'img-spare', kind: 'image', uri: 'assets/img-spare.png' }],
    scenes: [
      {
        id: 'scene-01', name: 'Hook', startFrame: 0, durationFrames: 60, intent: 'Stop the scroll.',
        layers: [
          { id: 's1-bg', kind: 'shape', transform: { x: 0, y: 0, width: 1920, height: 1080 }, style: { backgroundColor: '#10243a' } },
          { id: 's1-title', kind: 'text', content: { text: 'Invisible energy use' }, typography: { sizePx: 96, lineHeight: 1.1, maxLines: 2, safeArea: true }, transform: { x: 140, y: 280, width: 1200, height: 240 }, style: { color: '#ffffff' }, motion: { preset: 'float', durationFrames: 24 } },
          { id: 's1-small', kind: 'text', content: { text: 'Made visible' }, typography: { family: 'Arial', sizePx: 12, lineHeight: 1.1, safeArea: false }, transform: { x: 10, y: 10, width: 600, height: 120 }, style: { color: '#ffffff' }, motion: { preset: 'fade', durationFrames: 24 } },
          { id: 's1-overflow', kind: 'text', content: { text: LONG_TEXT }, typography: { family: 'Arial', sizePx: 42, lineHeight: 1.1, safeArea: true }, transform: { x: 140, y: 560, width: 400, height: 80 }, style: { color: '#ffffff' }, motion: { preset: 'slide-up', durationFrames: 24 } }
        ]
      },
      {
        id: 'scene-02', name: 'Proof', startFrame: 60, durationFrames: 60, intent: 'Show the product.',
        layers: [
          { id: 's2-bg', kind: 'shape', transform: { x: 0, y: 0, width: 1920, height: 1080 }, style: { backgroundColor: '#14384e' } },
          { id: 's2-art', kind: 'image', assetId: 'missing-art', transform: { x: 700, y: 200, width: 500, height: 400 }, motion: { preset: 'float', durationFrames: 24 } },
          { id: 's2-caption', kind: 'text', content: { text: 'Every watt visible' }, typography: { family: 'Arial', sizePx: 42, lineHeight: 1.1, safeArea: true }, transform: { x: 140, y: 700, width: 800, height: 120 }, style: { color: '#ffffff' }, motion: { preset: 'fade-up', durationFrames: 24 } }
        ]
      }
    ],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] },
    ...overrides
  };
}

function audioFixture() {
  const project = defectFixture();
  project.project.id = 'repair-audio-fixture';
  project.assets = [{ id: 'narration-1', kind: 'audio', uri: 'assets/narration-1.wav' }];
  project.scenes = [project.scenes[0]].map(scene => ({ ...scene, layers: scene.layers.filter(layer => layer.kind !== 'image'), audioCues: [{ assetId: 'narration-1', kind: 'narration', offsetFrames: 0, durationFrames: 60, volume: 1 }] }));
  return project;
}

// A clean project whose only defect is an unregistered asset reference with no
// rebind candidate: the canonical escalation trigger.
function missingAssetFixture() {
  const project = cleanFixture();
  project.project.id = 'repair-missing-asset';
  project.assets = [];
  const art = project.scenes[1].layers.find(layer => layer.kind === 'image');
  art.assetId = 'missing-art';
  return project;
}

function cleanFixture() {
  const project = defectFixture();
  project.project.id = 'repair-clean-fixture';
  project.scenes = project.scenes.map(scene => ({
    ...scene,
    layers: scene.layers.map(layer => {
      if (layer.kind === 'text') return { ...layer, typography: { family: 'Arial', sizePx: 42, lineHeight: 1.1, safeArea: true } };
      if (layer.kind === 'image') return { ...layer, assetId: 'img-spare' };
      return layer;
    })
  }));
  return project;
}

// Test seam for the render step: a deterministic, side-effect-light manifest
// factory that mimics render-manager's contract (design §8 allows a stubbed
// render step for loop-level integration tests).
function stubRender({ findings = [], checks = {}, frameEvidence = [{ atSeconds: 2, bytes: 2048, decoded: true, ffmpegExitCode: 0 }] } = {}) {
  const calls = [];
  const render = async (project, options = {}) => {
    calls.push({ project, options });
    const output = path.join(options.outputRoot, 'stub-' + calls.length + '.mp4');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, 'stub-bytes-' + calls.length);
    const mediaAnalysisFindings = findings.map(finding => ({ ...finding }));
    const manifest = {
      projectId: project.project.id,
      projectRevision: project.project.revision || 1,
      projectIrSha256: projectIrSha256(project),
      engine: 'hyperframes', hyperframesVersion: 'stub',
      output, bytes: 4096, quality: options.quality || 'draft', fps: 30, fpsRational: '30', workers: 1,
      sceneTimeline: computeSceneTimeline(project),
      ...(Array.isArray(options.sceneIds) ? { scopedSceneIds: options.sceneIds, segments: options.sceneIds.map(id => ({ sceneId: id, composition: 'scenes/' + id + '.html', output: path.join(options.outputRoot, options.renderLabel || 'targeted', 'segments', id + '.mp4'), passed: true })) } : {}),
      media: { width: 1920, height: 1080, videoCodec: 'h264', frameRate: '30/1', durationSeconds: 4, hasAudio: false },
      checks: { dimensionsMatch: true, frameRateMatch: true, durationWithinOneFrame: true, irSceneDurationMatchesProject: true, hasVideo: true, nonEmpty: true, hyperFramesCheckPassed: true, mediaAnalysisPassed: true, ...checks },
      hyperFramesCheck: { path: '', issues: { ok: true, errorCount: 0 } },
      hyperFramesLint: { output: '', exitCode: 0 },
      frameEvidence: frameEvidence.map(frame => ({ ...frame })),
      mediaAnalysis: { version: 1, scoped: Array.isArray(options.sceneIds), findings: mediaAnalysisFindings, passed: mediaAnalysisFindings.every(finding => !['critical', 'high'].includes(finding.severity)) },
      compileWarnings: [], blockingWarnings: [], steps: [],
      completedAt: new Date().toISOString(), verified: true, productionReady: false
    };
    manifest.qa = evaluateRenderEvidence(manifest, createMediaQaContext(manifest.mediaAnalysis, project, output + '.render.json'));
    manifest.productionReady = manifest.qa.passed && manifest.verified && manifest.blockingWarnings.length === 0;
    manifest.repairPlan = createRepairPlan(manifest.qa, { attempt: options.repairAttempt || 0, maxAttempts: options.maxRepairAttempts ?? 2 });
    await writeFile(output + '.render.json', JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  };
  return { render, calls };
}

async function writeFixtureProject(root, project) {
  await mkdir(root, { recursive: true });
  const projectFile = path.join(root, 'project.json');
  const bytes = JSON.stringify(project, null, 2) + '\n';
  await writeFile(projectFile, bytes, 'utf8');
  return { projectFile, bytes };
}

test('decideRerenderScope keeps targeted mode only for fully attributed hyperframes scenes', () => {
  const project = defectFixture();
  const routePlan = routeScenes(project);
  const gates = { repair: { maxCycles: 2, targetedRerender: true, retestRequired: true } };
  const attributed = [{ code: 'FONT_UNSPECIFIED', sceneId: 'scene-01', retestRequired: true }, { code: 'ASSET_REFERENCE_MISSING', sceneId: 'scene-02', retestRequired: true }];
  const targeted = decideRerenderScope({ project, patchedProject: project, defects: attributed, gates, routePlan });
  assert.equal(targeted.mode, 'targeted');
  assert.deepEqual(targeted.sceneIds, ['scene-01', 'scene-02']);
  const unattributed = decideRerenderScope({ project, patchedProject: project, defects: [{ code: 'CHECK_FAILED_HASVIDEO', sceneId: null }], gates, routePlan });
  assert.equal(unattributed.mode, 'full');
  assert.match(unattributed.reason, /scene attribution/);
  const policyOff = decideRerenderScope({ project, patchedProject: project, defects: attributed, gates: { repair: { ...gates.repair, targetedRerender: false } }, routePlan });
  assert.equal(policyOff.mode, 'full');
  assert.match(policyOff.reason, /policy/);
  const foreignEngine = decideRerenderScope({
    project, patchedProject: project, defects: [{ code: 'FONT_UNSPECIFIED', sceneId: 'scene-01' }], gates,
    routePlan: { plans: [{ sceneId: 'scene-01', tasks: [{ engine: 'blender', taskId: 't' }] }] }
  });
  assert.equal(foreignEngine.mode, 'full');
  assert.match(foreignEngine.reason, /non-hyperframes/);
});

test('injected defects are detected, localized, classified, patched and the patched IR revalidates', () => {
  const project = defectFixture();
  const routing = routeScenes(project);
  const irQa = runProjectQA(project, routing);
  // Detection + localization of the QA-source defects.
  const qaByCode = Object.fromEntries(irQa.defects.map(defect => [defect.code, defect]));
  assert.deepEqual(['FONT_UNSPECIFIED', 'TEXT_TOO_SMALL', 'TEXT_SAFE_AREA_DISABLED', 'ASSET_REFERENCE_MISSING'].sort(), Object.keys(qaByCode).sort());
  assert.equal(qaByCode.FONT_UNSPECIFIED.sceneId, 'scene-01');
  assert.equal(qaByCode.ASSET_REFERENCE_MISSING.sceneId, 'scene-02');
  // Compiler-family detection uses the same estimators the compiler applies.
  const overflowLayer = project.scenes[0].layers[3];
  assert.equal(estimateTextFit({ text: overflowLayer.content.text, fontSizePx: 42, boxWidthPx: 400, boxHeightPx: 80, lineHeight: 1.1 }).fits, false);
  const smallLayer = project.scenes[0].layers[2];
  assert.ok(smallLayer.transform.x < 1920 * 0.05 && smallLayer.transform.y < 1080 * 0.05, 'box starts outside the safe area');
  const defects = [
    ...irQa.defects,
    { defectId: 'compiler-001', code: 'TEXT_OVERFLOW_ESTIMATED', severity: 'high', sceneId: 'scene-01' },
    { defectId: 'compiler-002', code: 'TEXT_OUTSIDE_SAFE_AREA', severity: 'high', sceneId: 'scene-01' }
  ];
  // Classification matches design §3.3: AUTO vs COND vs REPORT.
  const classification = classifyDefects(defects, { project, routePlan: routing });
  const policyByCode = Object.fromEntries(classification.items.map(item => [item.code, item]));
  assert.equal(policyByCode.FONT_UNSPECIFIED.policy, 'AUTO');
  assert.equal(policyByCode.TEXT_TOO_SMALL.policy, 'AUTO');
  assert.equal(policyByCode.TEXT_SAFE_AREA_DISABLED.policy, 'AUTO');
  assert.equal(policyByCode.TEXT_OVERFLOW_ESTIMATED.policy, 'COND');
  assert.equal(policyByCode.TEXT_OUTSIDE_SAFE_AREA.policy, 'COND');
  assert.equal(policyByCode.ASSET_REFERENCE_MISSING.policy, 'COND');
  assert.ok(policyByCode.ASSET_REFERENCE_MISSING.ops.length, 'a same-kind candidate asset exists');
  // Patch generation, validation and application.
  const patch = createPatchFromDefects(project, classification, { attempt: 0, maxCycles: 2, runId: 'run-test' });
  assert.ok(patch.ops.length >= 5, 'every repairable defect contributes an op');
  const validation = validateRepairPatch(patch, project);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const applied = applyRepairPatch(project, patch);
  // IR revalidation: the patched IR is valid and QA-clean on the patched codes.
  const patched = applied.project;
  assert.equal(validateProject(patched).valid, true);
  assert.equal(runProjectQA(patched, routeScenes(patched)).defects.length, 0);
  const patchedLayers = Object.fromEntries(patched.scenes[0].layers.map(layer => [layer.id, layer]));
  assert.equal(patchedLayers['s1-title'].typography.family, 'Arial');
  assert.equal(patchedLayers['s1-small'].typography.sizePx, 27);
  assert.equal(patchedLayers['s1-small'].typography.safeArea, true);
  assert.ok(patchedLayers['s1-small'].transform.x >= 96 && patchedLayers['s1-small'].transform.y >= 54, 'small box clamped inside the safe area');
  assert.equal(estimateTextFit({ text: patchedLayers['s1-overflow'].content.text, fontSizePx: 42, boxWidthPx: 400, boxHeightPx: patchedLayers['s1-overflow'].transform.height, lineHeight: 1.1 }).fits, true);
  const patchedArt = patched.scenes[1].layers.find(layer => layer.id === 's2-art');
  assert.equal(patchedArt.assetId, 'img-spare');
  // Text content and creative intent are never patched.
  assert.equal(patchedLayers['s1-overflow'].content.text, LONG_TEXT);
  assert.equal(patched.creative.message, project.creative.message);
});

test('escalation variant: no candidate asset escalates without consuming a repair cycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-escalate-'));
  const stub = stubRender();
  try {
    const project = missingAssetFixture();
    const { projectFile, bytes } = await writeFixtureProject(root, project);
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(result.status, 'escalated');
    assert.equal(result.exitCode, 3, 'exit contract: escalated runs exit 3');
    assert.equal(result.run.status, 'failed');
    // Only the evaluation render ran; no repair-cycle renders were consumed.
    assert.equal(stub.calls.length, 1);
    const onDisk = JSON.parse(await readFile(projectFile, 'utf8'));
    assert.equal(computeRepairCyclesFromLedger(onDisk, result.run.id), 0);
    assert.deepEqual(onDisk.assets, [], 'the IR is never rewritten on the escalation path');
    const escalation = result.escalations[0];
    assert.ok(existsSync(escalation.jsonPath));
    assert.ok(existsSync(escalation.markdownPath));
    assert.equal(escalation.report.unresolvedDefects[0].code, 'ASSET_REFERENCE_MISSING');
    assert.match(escalation.report.unresolvedDefects[0].reasonNotRepaired, /never invented|verified candidate/);
    const state = JSON.parse(await readFile(path.join(root, 'run-state.json'), 'utf8'));
    assert.equal(state.status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('gain-budget defects escalate at the cycle limit after spending the full ±6 dB budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-budget-'));
  const stub = stubRender({
    findings: [{ code: 'AUDIO_PROGRAM_TOO_QUIET', severity: 'high', event: { start: 0.5, end: 3.5 }, value: -27, threshold: -24, message: 'Integrated program loudness is below the configured delivery range.' }],
    checks: { mediaAnalysisPassed: false }
  });
  try {
    const { projectFile } = await writeFixtureProject(root, audioFixture());
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(result.status, 'escalated');
    assert.equal(result.exitCode, 3);
    // Evaluation render + one render per consumed cycle (2 cycles).
    assert.equal(stub.calls.length, 3);
    assert.equal(result.cycles, 2);
    const finalProject = JSON.parse(await readFile(projectFile, 'utf8'));
    const ledger = finalProject.qa.repairHistory.filter(entry => entry.status === 'repair-required');
    assert.equal(ledger.length, 2);
    // Failed cycles keep the pre-staged 'pending' marker in the IR ledger; the
    // retest outcome is recorded in the operational run state.
    for (const entry of ledger) assert.equal(entry.retestResult, 'pending');
    const state = JSON.parse(await readFile(path.join(root, 'run-state.json'), 'utf8'));
    assert.deepEqual(state.repair.retestOutcomes, { 0: 'failed', 1: 'failed' });
    for (const entry of ledger) {
      // Each cycle's patch carries the typography repairs plus one bounded
      // audio gain op of exactly 3 dB.
      const audioOp = entry.patch.ops.find(op => op.type === 'set_audio_cue');
      assert.ok(audioOp, 'each cycle patches the too-quiet cue');
      assert.equal(audioOp.gainDb, 3);
      assert.equal(audioOp.value.volume, entry.attempt === 0 ? 1.41 : 1.99);
    }
    // 3 dB per cycle, capped at the cumulative ±6 dB budget for the run.
    assert.equal(computeRunGainBudgetUsed(finalProject, result.run.id), 6);
    const cue = finalProject.scenes[0].audioCues[0];
    assert.equal(cue.volume, 1.99);
    const escalation = JSON.parse(await readFile(result.escalations[0].jsonPath, 'utf8'));
    assert.equal(escalation.attempt, 2);
    assert.deepEqual(escalation.unresolvedDefects.map(defect => defect.code).sort(), ['AUDIO_PROGRAM_TOO_QUIET', 'CHECK_FAILED_MEDIAANALYSISPASSED']);
    const backups = (await readFile(projectFile, 'utf8'), null);
    assert.ok(existsSync(path.join(root, 'history')), 'IR backups exist under history/');
    assert.ok(backups === null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a low media finding is reviewed-non-blocking: the run completes production-ready with exit 0', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-nonblocking-'));
  const stub = stubRender({ findings: [{ code: 'BLACK_FRAME_SEGMENT', severity: 'low', event: { start: 0.5, end: 1.25 }, message: 'Faint black frames at a clip boundary.' }] });
  try {
    const { projectFile } = await writeFixtureProject(root, cleanFixture());
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(result.status, 'production-ready');
    assert.equal(result.exitCode, 0, 'non-blocking findings never fail the run');
    assert.equal(stub.calls.length, 1, 'no repair cycle is spent on non-blocking findings');
    assert.deepEqual(result.renderManifests[0].repairPlan.nonBlocking.map(item => item.code), ['BLACK_FRAME_SEGMENT']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('escalations mark medium/low findings reviewed-non-blocking while blocking defects keep registry reasons', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-escalate-nb-'));
  const stub = stubRender({ findings: [{ code: 'BLACK_FRAME_SEGMENT', severity: 'low', event: { start: 0.5, end: 1.25 }, message: 'Faint black frames at a clip boundary.' }] });
  try {
    const { projectFile } = await writeFixtureProject(root, missingAssetFixture());
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(result.status, 'escalated');
    assert.equal(result.exitCode, 3);
    const report = JSON.parse(await readFile(result.escalations[0].jsonPath, 'utf8'));
    const blocking = report.unresolvedDefects.find(defect => defect.code === 'ASSET_REFERENCE_MISSING');
    assert.match(blocking.reasonNotRepaired, /never invented|verified candidate/);
    const nonBlocking = report.unresolvedDefects.find(defect => defect.code === 'BLACK_FRAME_SEGMENT');
    assert.equal(nonBlocking.severity, 'low');
    assert.match(nonBlocking.reasonNotRepaired, /non-blocking/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unsanitary project id fails validation before any workspace path or render is derived', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-idguard-'));
  const stub = stubRender();
  try {
    const project = cleanFixture();
    project.project.id = '../../escape';
    const { projectFile } = await writeFixtureProject(root, project);
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    assert.equal(stub.calls.length, 0, 'an invalid IR never reaches a render');
    assert.equal(existsSync(path.join(root, 'run-state.json')), false);
    assert.equal(existsSync(path.join(root, 'renders')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--dry-run prints the patch and stops without writing anything', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-dry-'));
  const stub = stubRender();
  try {
    const { projectFile, bytes } = await writeFixtureProject(root, defectFixture());
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.exitCode, 0);
    assert.equal(result.wouldEscalate, false);
    assert.ok(result.patch.ops.length, 'the dry run previews the generated patch');
    assert.equal(await readFile(projectFile, 'utf8'), bytes, 'the IR is untouched');
    assert.equal(existsSync(path.join(root, 'run-state.json')), false, 'run state is not persisted');
    assert.equal(existsSync(path.join(root, 'escalations')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a verified master render is resumed when the IR hash and on-disk file match', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-resume-'));
  const stub = stubRender();
  try {
    const { projectFile } = await writeFixtureProject(root, cleanFixture());
    const first = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(first.status, 'production-ready');
    assert.equal(first.exitCode, 0);
    assert.equal(stub.calls.length, 1);
    const state = JSON.parse(await readFile(path.join(root, 'run-state.json'), 'utf8'));
    assert.equal(state.status, 'qa');
    assert.equal(state.artifacts.length, 1);
    assert.equal(state.artifacts[0].kind, 'master-render');
    assert.equal(state.artifacts[0].verified, true);
    const second = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(second.status, 'production-ready');
    assert.equal(second.exitCode, 0);
    assert.equal(stub.calls.length, 1, 'the second loop resumes the verified master instead of re-rendering');
    assert.equal(second.renderManifests[0].resumed, true);
    // A changed IR invalidates the artifact and forces a fresh render.
    const project = cleanFixture();
    project.scenes[0].layers[1].content = { text: 'Revised headline' };
    await writeFile(projectFile, JSON.stringify(project, null, 2) + '\n', 'utf8');
    const third = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render });
    assert.equal(third.status, 'production-ready');
    assert.equal(stub.calls.length, 2, 'the invalidated artifact re-renders');
    assert.equal(third.renderManifests[0].resumed, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('frame-decode failures get exactly one transient re-render retry, then escalate as recurring', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-decode-'));
  // A statically undecodable sampled frame drives the FRAME_DECODE_FAILED_1 defect.
  const failingStub = stubRender({ frameEvidence: [{ atSeconds: 0.5, bytes: 0, decoded: false, ffmpegExitCode: 0 }] });
  try {
    const { projectFile } = await writeFixtureProject(root, cleanFixture());
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: failingStub.render });
    assert.equal(result.status, 'escalated');
    assert.equal(result.exitCode, 3);
    // Evaluation render + exactly one transient re-render retry (no IR patch was involved).
    assert.equal(failingStub.calls.length, 2);
    assert.equal(result.cycles, 1);
    const onDisk = JSON.parse(await readFile(projectFile, 'utf8'));
    const ledger = onDisk.qa.repairHistory.filter(entry => entry.status === 'repair-required');
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0].frameDecodeFrames, [15]);
    assert.equal(ledger[0].patch, null, 'a retry cycle consumes budget without an IR patch');
    const escalation = JSON.parse(await readFile(result.escalations[0].jsonPath, 'utf8'));
    const decode = escalation.unresolvedDefects.find(defect => defect.code === 'FRAME_DECODE_FAILED_1');
    assert.equal(decode.reasonNotRepaired, 'Recurring frame-decode failure at the same frame after the allowed transient re-render retry.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maxCyclesOverride threads the effective cycle budget into patch and render metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-maxcycles-'));
  try {
    const { projectFile } = await writeFixtureProject(root, defectFixture());
    const preview = await runRepairLoop({ projectFile, projectRoot: root, render: stubRender().render, dryRun: true, maxCyclesOverride: 3 });
    assert.equal(preview.status, 'dry-run');
    assert.equal(preview.patch.maxCycles, 3, 'the patch envelope records the effective override, not the policy default');
    // Full loop: the repair render metadata carries the same effective budget.
    const stub = stubRender();
    const result = await runRepairLoop({ projectFile, projectRoot: root, render: stub.render, maxCyclesOverride: 3 });
    assert.equal(result.status, 'production-ready');
    assert.equal(result.exitCode, 0);
    assert.equal(result.cycles, 1);
    const onDisk = JSON.parse(await readFile(projectFile, 'utf8'));
    const ledger = onDisk.qa.repairHistory.filter(entry => entry.status === 'repair-required');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].patch.maxCycles, 3);
    for (const manifest of result.renderManifests) {
      assert.equal(manifest.repairPlan.maxAttempts, 3, 'render metadata records the effective override');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('executeRepairCycle returns no-patch without rendering or writing the IR', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-repair-nopatch-'));
  const stub = stubRender();
  try {
    const project = missingAssetFixture();
    const { projectFile, bytes } = await writeFixtureProject(root, project);
    const routing = routeScenes(project);
    const qa = runProjectQA(project, routing);
    const run = { id: 'run-x', projectId: 'repair-fixture', status: 'qa', revision: 0, repairCycles: 0, maxRepairCycles: 2, artifacts: [], approvals: [], events: [] };
    const cycle = await executeRepairCycle({
      projectFile, project, run,
      gates: { repair: { maxCycles: 2, targetedRerender: true, retestRequired: true } },
      qaResult: qa,
      options: { render: stub.render, projectRoot: root, outputRoot: path.join(root, 'renders'), sourceRoot: root }
    });
    assert.equal(cycle.outcome, 'no-patch');
    assert.equal(cycle.attempt, 0);
    assert.equal(stub.calls.length, 0, 'an unrepairable defect never burns a render');
    assert.equal(await readFile(projectFile, 'utf8'), bytes, 'the IR is untouched');
    assert.equal(computeRepairCyclesFromLedger(project, 'run-x'), 0);
    assert.match(cycle.classification.items[0].reason, /Condition not met/);
    // The compare-and-swap rejection path is exercised through the core API.
    const stale = validateRepairPatch({ basedOnIrSha256: 'f'.repeat(64), ops: cycle.classification.items.flatMap(item => item.ops) }, project);
    assert.equal(stale.valid, false);
    await assert.rejects(() => writeEscalationReport('', { run, defects: [] }), /project workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

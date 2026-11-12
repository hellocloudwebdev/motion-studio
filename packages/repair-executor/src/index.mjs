import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PatchError, applyRepairPatch, classifyDefects, createPatchFromDefects,
  createRepairPlan, evaluateRenderEvidence, persistQaRecord, projectIrSha256,
  runProjectQA, routeScenes, validateProject
} from '../../core/src/index.mjs';
import { createProductionRun, recordArtifact, transitionRun } from '../../orchestrator/src/index.mjs';
import { computeRepairCyclesFromLedger, defaultRunState, invalidateOnInputChange, loadRunState, saveRunState } from '../../orchestrator/src/run-state.mjs';
import { loadQualityGates } from '../../orchestrator/src/quality-gates.mjs';
import { computeSceneTimeline, createMediaQaContext, renderHyperFramesProject } from '../../render-manager/src/index.mjs';
import { analyzeRenderedMedia } from '../../render-manager/src/media-analysis.mjs';
import { finalizeMedia } from '../../ffmpeg/src/index.mjs';
import { audioInputsFromProjectRange } from '../../delivery-manager/src/audio-inputs.mjs';
import { computeRetestScope, evaluateRetestScope } from './retest-scope.mjs';
import { writeEscalationReport } from './escalation.mjs';

// Repair execution loop (design §4.2). The executor is the only writer of
// projects/<id>/{project.json,history/,run-state.json,escalations/}: every IR
// write is backed up and atomic, every cycle is one ledger entry in
// project.qa.repairHistory, and escalation cannot be bypassed.

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OVERRIDE_CYCLES = 3;

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

// Single sanitize helper for author-controlled ids that reach filesystem paths
// (project workspaces, run ids, escalation/retest artifact names): same charset
// as validate-project.mjs's id rule, so a valid IR id passes through unchanged
// while anything else cannot traverse or escape. Non-empty ids only.
const safeId = (value, fallback) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-') || fallback;

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}

function fpsOf(project) {
  const rate = project?.project?.frameRate;
  const numerator = Number(rate?.numerator), denominator = Number(rate?.denominator);
  if (!(numerator > 0) || !(denominator > 0)) throw new Error('Canonical Video IR frameRate must be a positive rational.');
  return numerator / denominator;
}

function secondsPerFrameOf(project) {
  const rate = project.project.frameRate;
  return rate.denominator / rate.numerator;
}

function transitionOrFail(run, nextStatus) {
  if (run.status === nextStatus) return run;
  return transitionRun(run, nextStatus);
}

// Hash-verified asset ids for the rebind_asset precondition (design §3.3):
// assets carrying a sha256 are only rebind candidates when the on-disk file
// inside the project source root hashes to the recorded value.
async function verifyProjectAssets(project, projectFile) {
  const verified = new Set();
  const sourceRoot = path.dirname(path.resolve(projectFile));
  for (const asset of Array.isArray(project?.assets) ? project.assets : []) {
    if (!asset?.id || typeof asset.sha256 !== 'string' || typeof asset.uri !== 'string') continue;
    try {
      const file = path.resolve(sourceRoot, asset.uri);
      const relative = path.relative(sourceRoot, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const bytes = await readFile(file);
      if (sha256Hex(bytes) === asset.sha256) verified.add(asset.id);
    } catch { /* unreadable or missing files stay unverified */ }
  }
  return verified;
}

// Resume-from-verified-artifact (design §5): a recorded master render is
// reusable only when it is verified, recorded for the exact current IR hash and
// the on-disk file still hashes to the recorded value. Anything else re-renders.
async function resumeVerifiedMaster(state, irHash) {
  for (const artifact of Array.isArray(state?.artifacts) ? state.artifacts : []) {
    if (artifact?.kind !== 'master-render' || artifact.verified !== true || artifact.projectIrSha256 !== irHash || typeof artifact.path !== 'string') continue;
    try {
      const bytes = await readFile(artifact.path);
      if (sha256Hex(bytes) !== artifact.sha256) continue;
      const manifest = JSON.parse(await readFile(artifact.path + '.render.json', 'utf8'));
      if (manifest.projectIrSha256 && manifest.projectIrSha256 !== irHash) continue;
      return manifest;
    } catch { /* stale or unreadable artifact: fall through to a fresh render */ }
  }
  return null;
}

async function recordMasterArtifact(run, state, manifest, project) {
  if (!manifest?.output || manifest.verified !== true) return { run, state };
  const irHash = projectIrSha256(project);
  const id = 'master-' + irHash.slice(0, 8);
  if (Array.isArray(state?.artifacts) && state.artifacts.some(artifact => artifact?.id === id)) return { run, state };
  let fileSha256 = null;
  try { fileSha256 = sha256Hex(await readFile(manifest.output)); } catch { return { run, state }; }
  const artifact = { id, kind: 'master-render', path: manifest.output, sha256: fileSha256, verified: true, projectIrSha256: irHash, recordedAt: new Date().toISOString() };
  return { run: recordArtifact(run, artifact), state: { ...state, artifacts: [...(Array.isArray(state.artifacts) ? state.artifacts : []), artifact] } };
}

// Merged defect stream for one loop evaluation: IR defects first, then
// render-evidence defects (design §4.2 step 4).
function mergedQaResult(project, manifest, manifestPath = null) {
  const irQa = runProjectQA(project, routeScenes(project));
  const renderQa = manifest ? (manifest.qa && Array.isArray(manifest.qa.defects)
    ? manifest.qa
    : evaluateRenderEvidence(manifest, createMediaQaContext(manifest.mediaAnalysis, project, manifestPath)))
    : { passed: true, productionReady: true, defects: [], summary: {} };
  const defects = [...(irQa.defects || []), ...(renderQa.defects || [])];
  const summary = { total: defects.length };
  for (const level of ['critical', 'high', 'medium', 'low']) summary[level] = defects.filter(defect => defect.severity === level).length;
  return {
    passed: irQa.passed !== false && renderQa.passed !== false && defects.every(defect => !['critical', 'high'].includes(defect.severity)),
    productionReady: irQa.passed === true && renderQa.productionReady === true,
    defects,
    summary
  };
}

// D3 rerender-scope decision: targeted (full recompile from the patched IR,
// then one segment render per affected scene) only when policy allows, every
// retested defect carries scene attribution, and the affected scenes run
// hyperframes tasks exclusively. A failing --composition render at runtime
// degrades to the whole-project path in executeRepairCycle.
export function decideRerenderScope({ project, patchedProject, defects, gates, routePlan } = {}) {
  const repair = gates?.repair && typeof gates.repair === 'object' ? gates.repair : (gates || {});
  const scope = { mode: 'full', sceneIds: [], reason: null };
  const sceneIds = affectedSceneIdsOf(defects);
  const unattributed = (Array.isArray(defects) ? defects : []).filter(defect => defect && defect.retestRequired !== false && !sceneIds.includes(defect.sceneId));
  if (!repair.targetedRerender) scope.reason = 'targetedRerender is disabled by policy.';
  else if (unattributed.length) scope.reason = 'defects without scene attribution force the whole-project path: ' + unattributed.map(defect => defect.code).join(', ');
  else if (!sceneIds.length) scope.reason = 'no affected scenes to rerender.';
  else {
    const known = new Set(((patchedProject || project)?.scenes || []).map(scene => scene?.id));
    const unknown = sceneIds.filter(sceneId => !known.has(sceneId));
    const nonHyperframes = [];
    for (const plan of routePlan?.plans || []) {
      if (!sceneIds.includes(plan.sceneId)) continue;
      for (const task of plan.tasks || []) if (task.engine !== 'hyperframes') nonHyperframes.push(plan.sceneId + ':' + task.engine);
    }
    if (unknown.length) scope.reason = 'affected scenes missing from the IR: ' + unknown.join(', ');
    else if (nonHyperframes.length) scope.reason = 'affected scenes carry non-hyperframes tasks: ' + nonHyperframes.join(', ');
    else return { mode: 'targeted', sceneIds, reason: 'all retested defects carry scene attribution and the affected scenes are hyperframes-only.' };
  }
  return scope;
}

function affectedSceneIdsOf(defects) {
  const sceneIds = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    if (!defect || defect.retestRequired === false) continue;
    const sceneId = defect.sceneId;
    if (typeof sceneId === 'string' && sceneId && sceneId !== 'project' && !sceneIds.includes(sceneId)) sceneIds.push(sceneId);
  }
  return sceneIds;
}

function frameDecodeFramesOf(defects) {
  return (Array.isArray(defects) ? defects : [])
    .filter(defect => String(defect?.code || '').startsWith('FRAME_DECODE_FAILED_'))
    .map(defect => Number(defect?.timeRangeFrames?.startFrame))
    .filter(frame => Number.isInteger(frame));
}

// One re-render retry per distinct frame for the lifetime of a run: a frame
// that already consumed its retry and fails again is recurring (design §3.3).
function hasRecurringFrameDecodeFailure(project, runId, frames) {
  const history = Array.isArray(project?.qa?.repairHistory) ? project.qa.repairHistory : [];
  return history.some(entry => entry?.runId === runId && Array.isArray(entry.frameDecodeFrames) && entry.frameDecodeFrames.some(frame => frames.includes(frame)));
}

// Renders stay inside the fixed-executable spawn paths of render-manager; the
// executor only bounds them with a timeout (design §4.1) and retries a timeout
// exactly once before failing the run.
async function renderBounded(impl, project, options, timeoutMs, userSignal) {
  const attempt = async () => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
    return impl(project, { ...options, signal });
  };
  try {
    return await attempt();
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return attempt();
  }
}

function decodeFrameAt(input, atSeconds, outputPath, signal) {
  return new Promise(resolve => {
    (async () => {
      await mkdir(path.dirname(outputPath), { recursive: true });
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', Number(atSeconds).toFixed(3), '-i', input, '-frames:v', '1', '-update', '1', outputPath], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal
      });
      let failed = false;
      child.once('error', () => { failed = true; resolve(false); });
      child.once('close', async code => {
        if (failed) return;
        if (code !== 0) return resolve(false);
        try { resolve((await stat(outputPath)).size > 0); } catch { resolve(false); }
      });
    })().catch(() => resolve(false));
  });
}

async function runRetest({ project, manifest, retestScope, effectiveScope, options, projectFile, fps }) {
  const checks = { ...(manifest?.checks || {}) };
  const audioFindings = [];
  const snapshotEvidence = [];
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  if (effectiveScope.mode === 'targeted' && segments.length) {
    for (const sample of retestScope.snapshotTimes) {
      const segment = segments.find(item => item.sceneId === sample.sceneId);
      const framePath = path.join(options.outputRoot, 'retest-frames', safeId(sample.sceneId, 'scene') + '-f' + sample.frame + '.png');
      const decoded = segment?.output ? await decodeFrameAt(segment.output, sample.segmentAtSeconds, framePath, options.signal) : false;
      snapshotEvidence.push({ sceneId: sample.sceneId, frame: sample.frame, atSeconds: sample.atSeconds, path: decoded ? framePath : null, decoded, ...(sample.clamped ? { clamped: true } : {}) });
    }
    for (const sceneId of retestScope.audioSceneIds) {
      const segment = segments.find(item => item.sceneId === sceneId);
      const timeline = computeSceneTimeline(project).find(item => item.sceneId === sceneId);
      if (!segment?.output || !timeline) continue;
      const audioInputs = await audioInputsFromProjectRange(project, projectFile, { startFrame: timeline.startFrame, endFrame: timeline.startFrame + timeline.durationFrames });
      if (!audioInputs.length) continue;
      // AUDIO_* retests run on the mixed segment: cues intersecting the scene
      // range are re-based to the segment start (design §4.2 step 10).
      const mixed = await finalizeMedia({
        input: segment.output,
        output: path.join(path.dirname(segment.output), safeId(sceneId, 'scene') + '-retest-mixed.mp4'),
        width: Number(project.project.canvas.width), height: Number(project.project.canvas.height),
        fps, durationSeconds: timeline.durationFrames * secondsPerFrameOf(project),
        videoCodec: 'libx264', audioCodec: 'aac', audioInputs, signal: options.signal
      });
      const analysis = await analyzeRenderedMedia({ input: mixed.output, media: mixed.media, frameEvidence: [], options: { ...(options.mediaAnalysis || {}) }, signal: options.signal });
      audioFindings.push(...analysis.findings.filter(finding => String(finding?.code || '').startsWith('AUDIO_')));
    }
  } else {
    audioFindings.push(...(((manifest?.mediaAnalysis?.findings) || []).filter(finding => String(finding?.code || '').startsWith('AUDIO_'))));
    for (const frame of Array.isArray(manifest?.frameEvidence) ? manifest.frameEvidence : []) {
      snapshotEvidence.push({ frame: Number.isFinite(Number(frame?.atSeconds)) ? Math.round(Number(frame.atSeconds) * fps) : null, atSeconds: frame?.atSeconds ?? null, decoded: frame?.decoded === true });
    }
  }
  return evaluateRetestScope(retestScope, { checks, audioFindings, snapshotEvidence });
}

function ledgerRetestScope(retestScope) {
  return {
    mode: retestScope.mode,
    sceneIds: retestScope.sceneIds,
    checks: retestScope.checks,
    audioSceneIds: retestScope.audioSceneIds,
    snapshotTimes: retestScope.snapshotTimes.map(sample => ({ sceneId: sample.sceneId, frame: sample.frame, atSeconds: sample.atSeconds, ...(sample.clamped ? { clamped: true } : {}) })),
    reason: retestScope.reason
  };
}

function markRetestResult(project, { runId, attempt, retestResult }) {
  const next = structuredClone(project);
  const history = Array.isArray(next.qa?.repairHistory) ? next.qa.repairHistory : [];
  const entry = [...history].reverse().find(item => item?.runId === runId && item?.attempt === attempt && item?.status === 'repair-required');
  if (!entry) throw new Error('Repair ledger entry for ' + runId + ' attempt ' + attempt + ' could not be found to record the retest result.');
  entry.retestResult = retestResult;
  return next;
}

// Step 8 (design §4.2): back up the previous project.json under history/ and
// write the new IR atomically. Backup names carry the new revision and the
// first 8 hex of the replaced IR hash.
async function backupAndWriteProject(projectFile, project, nextProject) {
  const historyDir = path.join(path.dirname(path.resolve(projectFile)), 'history');
  const oldHash = projectIrSha256(project);
  const newRevision = (Number.isInteger(nextProject.project?.revision) ? nextProject.project.revision : 1);
  const backupPath = path.join(historyDir, 'revision-' + newRevision + '-' + oldHash.slice(0, 8) + '.json');
  await mkdir(historyDir, { recursive: true });
  await copyFile(projectFile, backupPath);
  await atomicWriteJson(projectFile, nextProject);
  return backupPath;
}

export async function executeRepairCycle({ projectFile, project, run, gates, qaResult, options }) {
  if (!projectFile || !project || !run || !gates?.repair || !qaResult) throw new Error('executeRepairCycle requires projectFile, project, run, gates and qaResult.');
  const options_ = { maxCycles: gates.repair.maxCycles, ...options, timeoutMs: options?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS };
  const attempt = run.repairCycles;
  const artifacts = {};
  const routePlan = routeScenes(project);
  const fps = fpsOf(project);

  // Step 6: classify and generate. verifiedAssetIds enforces the hash-verified
  // rebind precondition; the ±6 dB gain budget is recounted from the run ledger.
  const verifiedAssetIds = await verifyProjectAssets(project, projectFile);
  const classification = classifyDefects(qaResult.defects, { project, routePlan, runId: run.id, verifiedAssetIds });
  // options_.maxCycles carries the effective override (--max-cycles) falling
  // back to the policy gate; patch and render metadata must record the budget
  // the loop actually honors.
  const patch = createPatchFromDefects(project, classification, { attempt, maxCycles: options_.maxCycles, runId: run.id });
  if (options_.dryRun) {
    return { outcome: 'dry-run', attempt, patch, classification, retestScope: null, artifacts, run, project: null };
  }

  let patchEnvelope = null;
  let patched = null;
  if (patch) {
    patchEnvelope = { ...patch, schemaVersion: '1.0.0', patchId: 'patch-' + run.id + '-a' + attempt, defectIds: qaResult.defects.map(defect => defect.defectId ?? null).filter(Boolean) };
    try {
      // Step 7: apply under CAS + no-new-issues; a rejection reclassifies the
      // defects as REPORT and consumes no cycle.
      const applied = applyRepairPatch(project, patchEnvelope);
      patched = applied.project;
      patched.project.revision = (Number.isInteger(project.project?.revision) ? project.project.revision : 1) + 1;
      artifacts.appliedOps = applied.appliedOps;
      artifacts.patchedIrSha256 = applied.patchedIrSha256;
    } catch (error) {
      const details = error instanceof PatchError ? { code: error.code, details: error.details ?? null } : { code: 'PATCH_FAILED', details: null };
      return { outcome: 'patch-rejected', attempt, patch: patchEnvelope, classification, retestScope: null, artifacts: { patchError: { ...details, message: error.message } }, run, project: null };
    }
  } else {
    // No IR patch exists. Only the frame-decode transient retry may proceed,
    // and only once per frame for the lifetime of the run.
    const retryFrames = frameDecodeFramesOf(qaResult.defects);
    if (!retryFrames.length || hasRecurringFrameDecodeFailure(project, run.id, retryFrames)) {
      return { outcome: 'no-patch', attempt, patch: null, classification, retestScope: null, artifacts: { ...(retryFrames.length ? { recurringFrameDecodeFrames: retryFrames } : {}) }, run, project: null };
    }
    patched = structuredClone(project);
    artifacts.frameDecodeRetryFrames = retryFrames;
  }

  // Step 9 + 10 planning: rerender scope first, then the retest scope; a retest
  // that cannot cover the defects upgrades the render to whole-project.
  const renderScope = decideRerenderScope({ project, patchedProject: patched, defects: qaResult.defects, gates, routePlan });
  const retestScope = computeRetestScope(qaResult.defects, renderScope.sceneIds, { fps, project: patched, targetedRerender: renderScope.mode === 'targeted' });
  const effectiveScope = renderScope.mode === 'targeted' && retestScope.mode === 'full'
    ? { mode: 'full', sceneIds: [], reason: retestScope.reason }
    : renderScope;
  artifacts.renderScope = effectiveScope;
  artifacts.retestScope = ledgerRetestScope(retestScope);

  // Second lock against bypassing the cycle limit before any repair work runs.
  run = transitionOrFail(run, 'repair');

  // Step 8: persist the patch (or retry record) — one ledger entry per executed
  // cycle, pre-staged before the render so the ledger recount (and the ±6 dB
  // gain budget) survives crashes and failed cycles. The render then binds the
  // exact on-disk IR hash.
  const frameDecodeFrames = frameDecodeFramesOf(qaResult.defects);
  let staged = persistQaRecord(patched, {
    run: { id: run.id },
    qaResult,
    repairPlan: { attempt, status: 'repair-required', actions: [] },
    patch: patchEnvelope,
    retestScope: ledgerRetestScope(retestScope),
    ...(frameDecodeFrames.length ? { frameDecodeFrames } : {})
  });
  staged = markRetestResult(staged, { runId: run.id, attempt, retestResult: 'pending' });
  artifacts.backupPath = await backupAndWriteProject(projectFile, project, staged);
  artifacts.projectIrSha256 = projectIrSha256(staged);

  const renderOptions = {
    projectRoot: options_.projectRoot,
    engineRoot: options_.engineRoot,
    outputRoot: options_.outputRoot,
    sourceRoot: options_.sourceRoot,
    installRoot: options_.installRoot,
    workers: 1,
    quality: options_.quality || 'draft',
    throwOnQaFailure: false,
    // Repair renders must never bake placeholder media (design §7.6).
    allowMissingAssetsAsPlaceholders: false,
    repairAttempt: attempt,
    maxRepairAttempts: options_.maxCycles,
    mediaAnalysis: options_.mediaAnalysis,
    onLine: options_.onLine
  };
  let manifest;
  if (effectiveScope.mode === 'targeted') {
    try {
      manifest = await renderBounded(options_.render || renderHyperFramesProject, staged, { ...renderOptions, sceneIds: effectiveScope.sceneIds, renderLabel: 'repair-a' + attempt }, options_.timeoutMs, options_.signal);
    } catch (error) {
      // D3 runtime fallback: a failing --composition path degrades to whole-project.
      manifest = await renderBounded(options_.render || renderHyperFramesProject, staged, { ...renderOptions, renderLabel: 'repair-a' + attempt }, options_.timeoutMs, options_.signal);
      artifacts.targetedFallback = { reason: error.message };
    }
  } else {
    manifest = await renderBounded(options_.render || renderHyperFramesProject, staged, {
      ...renderOptions,
      renderLabel: 'repair-a' + attempt,
      snapshotTimes: retestScope.snapshotTimes.map(sample => sample.atSeconds)
    }, options_.timeoutMs, options_.signal);
  }
  artifacts.renderManifest = manifest;

  // Step 10: retest the affected area. A failed retest leaves the staged IR on
  // disk untouched (its manifest stays hash-bound) so the next plan reuses the
  // evidence and the failed attempt cost only its own render (design D4).
  const retest = await runRetest({ project: staged, manifest, retestScope, effectiveScope, options: options_, projectFile, fps });
  let finalProject = staged;
  if (retest.passed) {
    // Step 11: record the retest result in the ledger; the master refresh in
    // the loop then renders this final IR and hash-binds delivery to it.
    finalProject = markRetestResult(staged, { runId: run.id, attempt, retestResult: 'passed' });
    await backupAndWriteProject(projectFile, staged, finalProject);
    artifacts.projectIrSha256 = projectIrSha256(finalProject);
  } else {
    artifacts.retestFailures = retest.failures;
  }

  run = transitionOrFail(run, 'rendering');
  return {
    outcome: patchEnvelope ? (retest.passed ? 'retested-pass' : 'retested-fail') : (retest.passed ? 'retry-pass' : 'retry-fail'),
    attempt,
    patch: patchEnvelope,
    retestScope: ledgerRetestScope(retestScope),
    artifacts,
    run,
    project: finalProject
  };
}

function syncRunState(state, run, project, runId, retestOutcomes = null) {
  const cycles = computeRepairCyclesFromLedger(project, runId);
  return {
    ...state,
    status: run.status,
    runId,
    repairCycles: cycles,
    repair: {
      cycles,
      maxCycles: state.policy?.maxCycles ?? null,
      ...(retestOutcomes ? { retestOutcomes: Object.fromEntries(retestOutcomes) } : {})
    },
    events: [
      ...(Array.isArray(state.events) ? state.events : []).filter(event => event?.type === 'inputs-invalidated'),
      ...(Array.isArray(run.events) ? run.events : []).map(event => ({ revision: event.revision, from: event.from, to: event.to, at: event.at, metadata: event.metadata }))
    ],
    updatedAt: new Date().toISOString()
  };
}

const NON_BLOCKING_SEVERITIES = new Set(['medium', 'low']);

async function escalateLoop({ projectRoot, run, defects, project, attempt, maxCycles, verdicts }) {
  // Medium/low findings ride along in the escalation record as reviewed-
  // non-blocking (the repair plan acts on critical/high only) instead of
  // inheriting a misleading registry reason.
  const verdictFor = defect => {
    const custom = typeof verdicts === 'function' ? verdicts(defect) : null;
    if (custom) return custom;
    if (NON_BLOCKING_SEVERITIES.has(defect?.severity)) {
      return 'Reviewed non-blocking: medium/low findings do not gate the repair loop (critical/high only); recorded here for review.';
    }
    return null;
  };
  const { jsonPath, markdownPath, report } = await writeEscalationReport(projectRoot, {
    run, defects, history: Array.isArray(project?.qa?.repairHistory) ? project.qa.repairHistory : [], attempt, maxCycles, verdicts: verdictFor
  });
  const failedRun = run.status === 'failed' ? run : (() => { try { return transitionRun(run, 'failed'); } catch { return run; } })();
  return { failedRun, escalation: { jsonPath, markdownPath, report } };
}

export async function runRepairLoop({
  projectFile, configPath, maxCyclesOverride, quality = 'draft', dryRun = false,
  targetedRerender, projectRoot, render, mediaAnalysis, timeoutMs = DEFAULT_RENDER_TIMEOUT_MS, signal, onLine
} = {}) {
  if (typeof projectFile !== 'string' || !projectFile.trim()) throw new Error('A project file path is required.');
  const projectFileAbs = path.resolve(projectFile);
  const escalations = [];
  const renderManifests = [];
  const errors = [];
  const finish = (status, exitCode, extra = {}) => ({ status, exitCode, run, project: current, escalations, renderManifests, cycles: run?.repairCycles ?? 0, errors, ...extra });

  let run = null;
  let current = null;
  let state = null;
  let projectRootAbs = null;
  // A failed cycle's render manifest stays hash-bound to the IR on disk, so the
  // next plan reuses it as its evaluation evidence instead of re-rendering
  // (design step 10: fail → loop to step 5; D4: failed attempts cost only
  // their own render).
  let carriedManifest = null;
  const retestOutcomes = new Map();
  // --dry-run stops at step 6 without persisting anything: run state stays a
  // pure in-memory projection for the preview.
  const persistState = async () => {
    if (dryRun || !projectRootAbs || !state) return;
    await saveRunState(projectRootAbs, state);
  };
  try {
    const fileBytes = await readFile(projectFileAbs, 'utf8');
    current = JSON.parse(fileBytes);
    // Step 1: load project and policy; a structurally invalid IR cannot enter
    // the validate-before-render loop.
    const validation = validateProject(current);
    if (!validation.valid) {
      return { status: 'failed', exitCode: 1, run: null, project: current, escalations, renderManifests, cycles: 0, errors: [{ message: 'The Canonical Video IR failed validation; repair requires a structurally valid project.', issues: validation.issues }] };
    }
    const gates = await loadQualityGates(configPath);
    const maxCycles = maxCyclesOverride === undefined || maxCyclesOverride === null
      ? gates.repair.maxCycles
      : (Number.isInteger(maxCyclesOverride) && maxCyclesOverride >= 0 && maxCyclesOverride <= MAX_OVERRIDE_CYCLES
        ? maxCyclesOverride
        : (() => { throw new Error('--max-cycles must be an integer between 0 and ' + MAX_OVERRIDE_CYCLES + '.'); })());
    const effectiveTargeted = targetedRerender === undefined ? gates.repair.targetedRerender : Boolean(targetedRerender);
    const effectiveGates = { ...gates, repair: { ...gates.repair, targetedRerender: effectiveTargeted } };

    projectRootAbs = path.resolve(projectRoot || path.join(process.cwd(), 'projects', safeId(current.project.id, 'project')));
    const engineRoot = path.join(projectRootAbs, 'engines', 'hyperframes');
    const outputRoot = path.join(projectRootAbs, 'renders');
    const context = {
      projectFile: projectFileAbs,
      sourceRoot: path.dirname(projectFileAbs),
      projectRoot: projectRootAbs,
      engineRoot,
      outputRoot,
      installRoot: MODULE_ROOT,
      quality,
      mediaAnalysis,
      timeoutMs,
      signal,
      onLine,
      render
    };

    // Step 1/2: run state, input-hash invalidation, ledger recount (D7).
    state = await loadRunState(projectRootAbs) || defaultRunState({ projectId: current.project.id });
    const irHash = projectIrSha256(current);
    const fileHash = sha256Hex(fileBytes);
    state = invalidateOnInputChange(state, { projectIrSha256: irHash, projectFileSha256: fileHash });
    const runId = safeId(state.runId || 'run-' + safeId(current.project.id, 'project') + '-' + Date.now(), 'run');
    state.runId = runId;
    state.policy = {
      ...(state.policy && typeof state.policy === 'object' ? state.policy : {}),
      maxCycles, targetedRerender: effectiveTargeted, retestRequired: gates.repair.retestRequired,
      workers: 1, qualityGatesSha256: gates.sha256
    };
    await persistState();
    run = createProductionRun({ id: runId, projectId: current.project.id, maxRepairCycles: maxCycles });
    // The IR ledger is authoritative for consumed cycles (design D7).
    run.repairCycles = computeRepairCyclesFromLedger(current, runId);
    state = syncRunState(state, run, current, runId, retestOutcomes);
    await persistState();

    for (;;) {
      // Step 3: render, or reuse a verified/cycle manifest bound to the exact
      // current IR hash.
      if (run.status === 'draft') run = transitionRun(run, 'planned');
      if (run.status === 'planned') run = transitionRun(run, 'rendering');
      const irHashNow = projectIrSha256(current);
      let manifest = carriedManifest && carriedManifest.projectIrSha256 === irHashNow ? carriedManifest : await resumeVerifiedMaster(state, irHashNow);
      carriedManifest = null;
      if (manifest) manifest.resumed = true;
      if (!manifest) {
        manifest = await renderBounded(context.render || renderHyperFramesProject, current, {
          projectRoot: context.projectRoot, engineRoot: context.engineRoot, outputRoot: context.outputRoot,
          sourceRoot: context.sourceRoot, installRoot: context.installRoot,
          workers: 1, quality: context.quality, throwOnQaFailure: false,
          allowMissingAssetsAsPlaceholders: false,
          repairAttempt: run.repairCycles, maxRepairAttempts: maxCycles,
          mediaAnalysis: context.mediaAnalysis, onLine: context.onLine
        }, context.timeoutMs, context.signal);
      }
      renderManifests.push(manifest);
      run = transitionOrFail(run, 'qa');
      state = syncRunState(state, run, current, runId, retestOutcomes);
      await persistState();

      // Step 4: evaluate merged defects; step 5: plan within the cycle budget.
      const qa = mergedQaResult(current, manifest, manifest.output ? manifest.output + '.render.json' : null);
      const plan = createRepairPlan(qa, { attempt: run.repairCycles, maxAttempts: maxCycles });
      if (plan.status === 'no-action') {
        const recorded = await recordMasterArtifact(run, state, manifest, current);
        run = recorded.run;
        state = syncRunState(recorded.state, run, current, runId, retestOutcomes);
        await persistState();
        return finish(manifest.productionReady === true ? 'production-ready' : 'no-action', 0);
      }
      if (plan.status === 'escalate') {
        const { failedRun, escalation } = await escalateLoop({
          projectRoot: projectRootAbs, run, defects: qa.defects, project: current,
          attempt: run.repairCycles, maxCycles
        });
        run = failedRun;
        escalations.push(escalation);
        state = syncRunState(state, run, current, runId, retestOutcomes);
        await persistState();
        return finish('escalated', 3, { escalations });
      }

      // Steps 6-10: one repair cycle.
      const cycle = await executeRepairCycle({
        projectFile: projectFileAbs,
        project: current,
        run,
        gates: effectiveGates,
        qaResult: qa,
        options: { ...context, dryRun, maxCycles }
      });
      if (cycle.outcome === 'dry-run') {
        // --dry-run prints the patch (or the would-be escalation) and stops
        // without writing anything.
        return finish('dry-run', 0, {
          patch: cycle.patch,
          classification: cycle.classification,
          wouldEscalate: !cycle.patch,
          escalationReasons: cycle.patch ? [] : cycle.classification.items.filter(item => !item.ops.length).map(item => ({ code: item.code, reason: item.reason }))
        });
      }
      if (cycle.outcome === 'patch-rejected' || cycle.outcome === 'no-patch') {
        // No cycle was consumed: the defects are reclassified REPORT and the
        // loop escalates instead of improvising.
        const recurring = cycle.outcome === 'no-patch' && Array.isArray(cycle.artifacts?.recurringFrameDecodeFrames);
        const { failedRun, escalation } = await escalateLoop({
          projectRoot: projectRootAbs, run, defects: qa.defects, project: current,
          attempt: run.repairCycles, maxCycles,
          verdicts: defect => {
            if (recurring && String(defect?.code || '').startsWith('FRAME_DECODE_FAILED_')) {
              return 'Recurring frame-decode failure at the same frame after the allowed transient re-render retry.';
            }
            if (cycle.outcome === 'patch-rejected') {
              return 'The generated repair patch was rejected (' + (cycle.artifacts?.patchError?.code || 'PATCH_FAILED') + '); the defect is treated as reportable-only.';
            }
            return null;
          }
        });
        run = failedRun;
        escalations.push(escalation);
        state = syncRunState(state, run, current, runId, retestOutcomes);
        await persistState();
        return finish('escalated', 3, { escalations });
      }

      // The cycle wrote the patched IR; the ledger is authoritative again.
      if (cycle.artifacts?.renderManifest) renderManifests.push(cycle.artifacts.renderManifest);
      const retestPassed = cycle.outcome === 'retested-pass' || cycle.outcome === 'retry-pass';
      retestOutcomes.set(cycle.attempt, retestPassed ? 'passed' : 'failed');
      // A passed cycle loops into the step-11 master refresh (a full
      // proven-path render of the final IR); a failed one loops to step 5 with
      // the retest evidence carried over.
      carriedManifest = retestPassed ? null : cycle.artifacts?.renderManifest ?? null;
      current = cycle.project;
      run = cycle.run;
      run.repairCycles = computeRepairCyclesFromLedger(current, runId);
      state = syncRunState(state, run, current, runId, retestOutcomes);
      await persistState();
    }
  } catch (error) {
    errors.push({ message: error?.message ?? String(error) });
    if (projectRootAbs && state && run) {
      try {
        if (run.status !== 'failed' && run.status !== 'delivered' && run.status !== 'cancelled') {
          try { run = transitionRun(run, 'failed'); } catch { /* already terminal */ }
        }
        if (!dryRun) await saveRunState(projectRootAbs, syncRunState(state, run, current ?? {}, run.id));
      } catch { /* best-effort persistence of the failure state */ }
    }
    return finish('failed', 1);
  }
}

import { computeSceneTimeline } from '../../render-manager/src/index.mjs';

// Pure retest-scope planning (design §4.2 step 10): a repair cycle never
// re-qualifies the whole project blindly — it reruns the union of failed
// output-contract checks plus the standard contract set, samples each affected
// scene at its start / midpoint / last frame plus adjacent boundary frames, and
// re-runs AUDIO_* analyses on a re-based mixed segment. Evaluation itself stays
// side-effect free; the executor performs the fs/FFmpeg work.

const BASELINE_CHECKS = ['dimensionsMatch', 'frameRateMatch', 'durationWithinOneFrame', 'hyperFramesCheckPassed', 'mediaAnalysisPassed'];
// Render-manager check names, used to map CHECK_FAILED_<UPPER_SNAKE> defects
// back onto the concrete check they failed.
const KNOWN_RENDER_CHECKS = ['dimensionsMatch', 'frameRateMatch', 'durationWithinOneFrame', 'irSceneDurationMatchesProject', 'hasVideo', 'nonEmpty', 'segmentsComplete', 'hyperFramesCheckPassed', 'mediaAnalysisPassed'];

export function failedChecksFromDefects(defects) {
  const names = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    const code = String(defect?.code || '');
    if (!code.startsWith('CHECK_FAILED_')) continue;
    const suffix = code.slice('CHECK_FAILED_'.length);
    const known = KNOWN_RENDER_CHECKS.find(name => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') === suffix);
    if (known && !names.includes(known)) names.push(known);
  }
  return names;
}

function affectedSceneIds(defects) {
  const sceneIds = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    if (!defect || defect.retestRequired === false) continue;
    const sceneId = defect.sceneId;
    if (typeof sceneId === 'string' && sceneId && sceneId !== 'project' && !sceneIds.includes(sceneId)) sceneIds.push(sceneId);
  }
  return sceneIds;
}

function clampSampleSeconds(seconds, totalSeconds, fps) {
  // Exactly render-manager's snapshot clamping: never before 0, never past the
  // last decodable frame of the timeline. `moved` flags samples clamping
  // actually shifted (epsilon-tolerant against float rounding) so the ledger
  // can mark evidence whose claimed frame was never really decodable.
  const clamped = Math.max(0, Math.min(totalSeconds - 1 / fps, seconds));
  return { seconds: clamped, moved: Math.abs(clamped - seconds) > 1e-9 };
}

export function computeRetestScope(defects, affectedScenes, { fps, project, targetedRerender = true } = {}) {
  const fpsValue = Number(fps);
  if (!Number.isFinite(fpsValue) || fpsValue <= 0) throw new Error('computeRetestScope requires a positive fps.');
  const checks = [...BASELINE_CHECKS];
  for (const name of failedChecksFromDefects(defects)) if (!checks.includes(name)) checks.push(name);
  const timeline = computeSceneTimeline(project);
  const candidateSceneIds = (Array.isArray(affectedScenes) ? affectedScenes : []).filter(id => typeof id === 'string' && id && timeline.some(item => item.sceneId === id));
  const audioSceneIds = candidateSceneIds.filter(sceneId => (Array.isArray(defects) ? defects : []).some(defect => String(defect?.code || '').startsWith('AUDIO_') && defect.sceneId === sceneId));
  const totalFrames = Number.isInteger(Number(project?.project?.totalDurationFrames)) ? Number(project.project.totalDurationFrames) : timeline.reduce((sum, item) => Math.max(sum, item.startFrame + item.durationFrames), 0);
  const totalSeconds = totalFrames / fpsValue;
  const snapshotTimes = [];
  for (const entry of timeline) {
    if (!candidateSceneIds.includes(entry.sceneId)) continue;
    const sceneSeconds = entry.durationFrames / fpsValue;
    const frames = [entry.startFrame, entry.startFrame + Math.floor(entry.durationFrames / 2), entry.startFrame + entry.durationFrames - 1];
    // Adjacent boundary samples only when the neighbouring frame is inside the project.
    if (entry.startFrame - 1 >= 0) frames.push(entry.startFrame - 1);
    if (entry.startFrame + entry.durationFrames <= totalFrames - 1) frames.push(entry.startFrame + entry.durationFrames);
    for (const frame of [...new Set(frames)].sort((a, b) => a - b)) {
      const at = clampSampleSeconds(frame / fpsValue, totalSeconds, fpsValue);
      const segmentAt = clampSampleSeconds((frame - entry.startFrame) / fpsValue, sceneSeconds, fpsValue);
      snapshotTimes.push({
        sceneId: entry.sceneId,
        frame,
        atSeconds: at.seconds,
        segmentAtSeconds: segmentAt.seconds,
        // Adjacent-boundary samples clamp to the segment edges: they decode a
        // frame that was never sampled, so they are labeled and excluded from
        // the pass/fail decode assertions.
        clamped: at.moved || segmentAt.moved
      });
    }
  }
  const uncovered = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    if (!defect || defect.retestRequired === false) continue;
    const covered = targetedRerender && project && candidateSceneIds.length > 0
      && typeof defect.sceneId === 'string' && candidateSceneIds.includes(defect.sceneId)
      && (!String(defect.code || '').startsWith('CHECK_FAILED_') || checks.includes(failedChecksFromDefects([defect])[0]));
    if (!covered) uncovered.push({ defectId: defect.defectId ?? null, code: defect.code });
  }
  const targeted = targetedRerender && project && candidateSceneIds.length > 0 && uncovered.length === 0;
  const reason = targeted
    ? 'retest scope covers every affected scene, failed check and required retest.'
    : !targetedRerender
      ? 'targetedRerender is disabled by policy.'
      : !project || candidateSceneIds.length === 0
        ? 'no attributable affected scenes; whole-project retest required.'
        : 'retestRequired defects are not covered by a targeted scope: ' + uncovered.map(item => item.code).join(', ');
  return {
    mode: targeted ? 'targeted' : 'full',
    sceneIds: targeted ? candidateSceneIds : [],
    checks,
    snapshotTimes,
    audioSceneIds: targeted ? audioSceneIds : [],
    uncovered: targeted ? [] : uncovered,
    reason
  };
}

export function evaluateRetestScope(scope, { checks = {}, audioFindings = [], snapshotEvidence = [] } = {}) {
  const failures = [];
  for (const name of Array.isArray(scope?.checks) ? scope.checks : []) {
    if (checks[name] !== true) failures.push({ type: 'check', name, actual: checks[name] ?? null });
  }
  for (const finding of Array.isArray(audioFindings) ? audioFindings : []) {
    if (String(finding?.code || '').startsWith('AUDIO_')) failures.push({ type: 'audio', code: finding.code, message: finding.message ?? null });
  }
  for (const sample of Array.isArray(snapshotEvidence) ? snapshotEvidence : []) {
    // Clamped samples were decoded at a segment edge, never at their claimed
    // frame; they stay in the evidence but are not held against the run.
    if (sample?.clamped === true) continue;
    if (sample?.decoded !== true) failures.push({ type: 'snapshot', sceneId: sample?.sceneId ?? null, frame: sample?.frame ?? null, atSeconds: sample?.atSeconds ?? null });
  }
  return { passed: failures.length === 0, failures, checks: scope?.checks ?? [] };
}

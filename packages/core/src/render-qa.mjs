import { secondsToFrameRange, mapEventToScenes, fpsValue } from "./frame-time.mjs";

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
const knownSeverities = new Set(["critical", "high", "medium", "low"]);

function defect(code, severity, description, repairOwner = "technical-qa", sceneId = null, evidence = null, timeRangeFrames = null) {
  return { defectId: "render-" + code.toLowerCase().replace(/[^a-z0-9]+/g, "-"), category: "render-evidence", severity, code, description, repairOwner, sceneId, timeRangeFrames, evidence, retestRequired: true };
}

function mediaRepairOwner(code) {
  if (code.startsWith("AUDIO_")) return "audio-producer";
  if (code.startsWith("OCR_")) return "typography-specialist";
  return "technical-qa";
}

function mediaFindingDefects(findings, { fps, scenes, evidencePath }) {
  const defects = [];
  let sequence = 0;
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || typeof finding !== "object") continue;
    sequence += 1;
    const code = String(finding.code || "MEDIA_FINDING");
    const range = finding.timeRangeFrames && Number.isInteger(finding.timeRangeFrames.startFrame) && Number.isInteger(finding.timeRangeFrames.endFrame) ? { startFrame: finding.timeRangeFrames.startFrame, endFrame: finding.timeRangeFrames.endFrame } : secondsToFrameRange(finding.event ?? finding.atSeconds ?? null, fps);
    const sceneIds = range ? mapEventToScenes(range.startFrame, range.endFrame, scenes) : [];
    const evidence = { type: "media-analysis", ...(evidencePath ? { path: evidencePath } : {}), ...(sceneIds.length > 1 ? { sceneIds } : {}) };
    // Measured value/threshold ride along so conditional repair builders (audio
    // gain rows) can derive bounded ops from the defect itself.
    defects.push({ defectId: "media-" + String(sequence).padStart(3, "0"), category: "render-media", severity: knownSeverities.has(finding.severity) ? finding.severity : "medium", code, description: String(finding.message || "A media-analysis finding was recorded against the rendered output."), repairOwner: mediaRepairOwner(code), sceneId: sceneIds[0] || "project", timeRangeFrames: range, evidence, ...(finding.value === undefined ? {} : { value: finding.value }), ...(finding.threshold === undefined ? {} : { threshold: finding.threshold }), retestRequired: true });
  }
  return defects;
}

// Blocking compiler defects gain scene attribution from the render manifest's
// scene timeline only where the warning itself does not already carry it; media
// findings keep their own render-media attribution path.
function timelineAttribution(warning, sceneTimeline) {
  const entries = sceneTimeline.filter(item => item && typeof item.sceneId === "string" && Number.isInteger(item.startFrame) && Number.isInteger(item.durationFrames) && item.durationFrames > 0);
  if (typeof warning?.sceneId === "string" && warning.sceneId) {
    const entry = entries.find(item => item.sceneId === warning.sceneId);
    return { sceneId: warning.sceneId, timeRangeFrames: entry ? { startFrame: entry.startFrame, endFrame: entry.startFrame + entry.durationFrames } : null };
  }
  const range = warning?.timeRangeFrames;
  if (range && Number.isInteger(range.startFrame) && Number.isInteger(range.endFrame)) {
    const entry = entries.find(item => item.startFrame <= range.startFrame && range.startFrame < item.startFrame + item.durationFrames);
    if (entry) return { sceneId: entry.sceneId, timeRangeFrames: range };
  }
  return { sceneId: null, timeRangeFrames: null };
}

export function evaluateRenderEvidence(manifest, context = {}) {
  const defects = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { passed: false, productionReady: false, defects: [defect("RENDER_MANIFEST_MISSING", "critical", "A render evidence manifest is required.")], summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0 } };
  }
  if (manifest.verified !== true) defects.push(defect("RENDER_NOT_VERIFIED", "critical", "The renderer did not mark the output contract as verified."));
  if (!manifest.output || typeof manifest.output !== "string") defects.push(defect("OUTPUT_PATH_MISSING", "critical", "The render manifest does not identify an output artifact."));
  if (!(Number(manifest.bytes) > 0)) defects.push(defect("OUTPUT_EMPTY", "critical", "The output artifact is missing or has zero bytes."));
  const fps = fpsValue(manifest.fpsRational) || fpsValue(manifest.fps);
  const checks = manifest.checks && typeof manifest.checks === "object" ? manifest.checks : {};
  if (!Object.keys(checks).length) defects.push(defect("OUTPUT_CHECKS_MISSING", "high", "No output-contract checks were recorded."));
  for (const [name, passed] of Object.entries(checks)) {
    if (passed !== true) defects.push(defect("CHECK_FAILED_" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), "high", "Output-contract check failed: " + name + "."));
  }
  const frames = Array.isArray(manifest.frameEvidence) ? manifest.frameEvidence : [];
  if (!frames.length) defects.push(defect("FRAME_EVIDENCE_MISSING", "high", "No decoded frame evidence was recorded."));
  frames.forEach((frame, index) => {
    if (frame?.decoded !== true || !(Number(frame.bytes) > 0)) {
      const atSeconds = Number(frame?.atSeconds);
      const frameIndex = fps > 0 && Number.isFinite(atSeconds) ? Math.round(atSeconds * fps) : null;
      defects.push(defect("FRAME_DECODE_FAILED_" + (index + 1), "high", "Sampled frame " + (index + 1) + " could not be decoded.", "render-engine", frame?.sceneId || null, frame?.path ? { type: "frame", path: frame.path, atSeconds } : { type: "frame-sample", atSeconds }, frameIndex === null ? null : { startFrame: frameIndex, endFrame: frameIndex + 1 }));
    }
  });
  const sceneTimeline = Array.isArray(manifest.sceneTimeline) ? manifest.sceneTimeline : [];
  for (const warning of Array.isArray(manifest.blockingWarnings) ? manifest.blockingWarnings : []) {
    const attribution = timelineAttribution(warning, sceneTimeline);
    defects.push(defect("BLOCKING_" + String(warning.code || "WARNING"), "high", warning.message || "A blocking compiler warning remains.", warning.repairOwner || "engine-router", warning.sceneId || attribution.sceneId, warning.evidence || null, warning.timeRangeFrames || attribution.timeRangeFrames));
  }
  defects.push(...mediaFindingDefects(context?.mediaFindings, { fps, scenes: context?.scenes, evidencePath: context?.evidencePath }));
  const summary = Object.fromEntries(["critical", "high", "medium", "low"].map(level => [level, defects.filter(item => item.severity === level).length]));
  summary.total = defects.length;
  const passed = !defects.some(item => severityRank[item.severity] <= severityRank.high);
  return { passed, productionReady: passed && manifest.productionReady === true, defects, summary };
}

export function createRepairPlan(qaResult, options = {}) {
  const maxAttempts = Math.max(0, Math.min(3, Number.isInteger(options.maxAttempts) ? options.maxAttempts : 2));
  const attempt = Math.max(0, Number.isInteger(options.attempt) ? options.attempt : 0);
  const defects = [...(qaResult?.defects || [])].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  // The plan acts on exactly the severities the QA gate itself blocks on
  // (critical and high). Medium/low findings are recorded as reviewed-
  // non-blocking so they stay visible without making production-ready
  // unreachable or burning repair cycles on REPORT-only rows.
  const blocks = item => severityRank[item?.severity] <= severityRank.high;
  const actionable = defects.filter(item => blocks(item) && item.retestRequired !== false && item.repairOwner);
  const nonBlocking = defects.filter(item => item && !blocks(item)).map(item => ({
    defectId: item.defectId ?? null,
    code: item.code,
    severity: item.severity ?? "medium",
    sceneId: item.sceneId ?? null,
    repairOwner: item.repairOwner ?? null
  }));
  const groups = new Map();
  for (const item of actionable) {
    const key = item.sceneId || "project";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const status = actionable.length ? (attempt >= maxAttempts ? "escalate" : "repair-required") : "no-action";
  return {
    status,
    attempt,
    maxAttempts,
    bounded: true,
    nonBlocking,
    actions: status === "escalate" ? [] : [...groups].map(([scope, items]) => ({
      scope,
      repairOwner: items[0].repairOwner,
      defectIds: items.map(item => item.defectId),
      instruction: "Repair only the listed defects within this scope, preserve unrelated project state, then rerun render QA."
    })),
    escalation: status === "escalate" ? "Repair retry limit reached; require human review." : null
  };
}

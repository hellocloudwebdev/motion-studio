const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };

function defect(code, severity, description, repairOwner = "technical-qa", sceneId = null) {
  return { defectId: "render-" + code.toLowerCase().replace(/[^a-z0-9]+/g, "-"), category: "render-evidence", severity, code, description, repairOwner, sceneId, retestRequired: true };
}

export function evaluateRenderEvidence(manifest) {
  const defects = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { passed: false, productionReady: false, defects: [defect("RENDER_MANIFEST_MISSING", "critical", "A render evidence manifest is required.")], summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0 } };
  }
  if (manifest.verified !== true) defects.push(defect("RENDER_NOT_VERIFIED", "critical", "The renderer did not mark the output contract as verified."));
  if (!manifest.output || typeof manifest.output !== "string") defects.push(defect("OUTPUT_PATH_MISSING", "critical", "The render manifest does not identify an output artifact."));
  if (!(Number(manifest.bytes) > 0)) defects.push(defect("OUTPUT_EMPTY", "critical", "The output artifact is missing or has zero bytes."));
  const checks = manifest.checks && typeof manifest.checks === "object" ? manifest.checks : {};
  if (!Object.keys(checks).length) defects.push(defect("OUTPUT_CHECKS_MISSING", "high", "No output-contract checks were recorded."));
  for (const [name, passed] of Object.entries(checks)) {
    if (passed !== true) defects.push(defect("CHECK_FAILED_" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), "high", "Output-contract check failed: " + name + "."));
  }
  const frames = Array.isArray(manifest.frameEvidence) ? manifest.frameEvidence : [];
  if (!frames.length) defects.push(defect("FRAME_EVIDENCE_MISSING", "high", "No decoded frame evidence was recorded."));
  frames.forEach((frame, index) => {
    if (frame?.decoded !== true || !(Number(frame.bytes) > 0)) defects.push(defect("FRAME_DECODE_FAILED_" + (index + 1), "high", "Sampled frame " + (index + 1) + " could not be decoded."));
  });
  for (const warning of Array.isArray(manifest.blockingWarnings) ? manifest.blockingWarnings : []) {
    defects.push(defect("BLOCKING_" + String(warning.code || "WARNING"), "high", warning.message || "A blocking compiler warning remains.", "engine-router", warning.sceneId || null));
  }
  const summary = Object.fromEntries(["critical", "high", "medium", "low"].map(level => [level, defects.filter(item => item.severity === level).length]));
  summary.total = defects.length;
  const passed = !defects.some(item => severityRank[item.severity] <= severityRank.high);
  return { passed, productionReady: passed && manifest.productionReady === true, defects, summary };
}

export function createRepairPlan(qaResult, options = {}) {
  const maxAttempts = Math.max(0, Math.min(3, Number.isInteger(options.maxAttempts) ? options.maxAttempts : 2));
  const attempt = Math.max(0, Number.isInteger(options.attempt) ? options.attempt : 0);
  const defects = [...(qaResult?.defects || [])].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const actionable = defects.filter(item => item.retestRequired !== false && item.repairOwner);
  const groups = new Map();
  for (const item of actionable) {
    const key = item.sceneId || "project";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return {
    status: attempt >= maxAttempts ? "escalate" : actionable.length ? "repair-required" : "no-action",
    attempt,
    maxAttempts,
    bounded: true,
    actions: attempt >= maxAttempts ? [] : [...groups].map(([scope, items]) => ({
      scope,
      repairOwner: items[0].repairOwner,
      defectIds: items.map(item => item.defectId),
      instruction: "Repair only the listed defects within this scope, preserve unrelated project state, then rerun render QA."
    })),
    escalation: attempt >= maxAttempts ? "Repair retry limit reached; require human review." : null
  };
}

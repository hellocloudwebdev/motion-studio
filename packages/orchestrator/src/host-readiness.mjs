const ENGINE_HOST = {
  hyperframes: 'hyperframes',
  'after-effects': 'afterEffects',
  blender: 'blender',
  threejs: 'threejs',
  'premiere-pro': 'premiere',
  premiere: 'premiere',
  ffmpeg: 'ffmpeg'
};

function isHostReady(engine, check = {}) {
  if (engine === 'after-effects') return check.serverConnected === true && check.contextAvailable === true;
  if (engine === 'premiere-pro' || engine === 'premiere') return check.serverConnected === true && check.hostVerified === true;
  return check.available === true;
}

export function evaluateHostReadiness(routePlan, hostChecks = {}) {
  const engines = new Set();
  for (const scene of routePlan?.plans || []) {
    for (const task of scene.tasks || []) if (task.engine) engines.add(task.engine);
  }
  // The production graph always ends in Premiere editorial assembly and FFmpeg delivery.
  engines.add('premiere-pro');
  engines.add('ffmpeg');
  const checks = [...engines].sort().map(engine => {
    const host = ENGINE_HOST[engine];
    const evidence = host ? hostChecks[host] || {} : {};
    const ready = Boolean(host) && isHostReady(engine, evidence);
    return {
      engine,
      host: host || null,
      ready,
      evidence: structuredClone(evidence),
      reason: !host ? 'No host adapter is registered for this engine.' : ready ? null : 'Required host verification evidence is missing or unsuccessful.'
    };
  });
  return {
    ready: checks.length > 0 && checks.every(check => check.ready),
    checkedAt: new Date().toISOString(),
    checks,
    missing: checks.filter(check => !check.ready).map(check => check.engine)
  };
}

const APPROVAL_STAGES = new Set(['after-effects-comp', 'premiere-assembly', 'final-export']);
const STAGE_ENGINES = {
  'after-effects-comp': ['after-effects'],
  'premiere-assembly': ['premiere-pro'],
  'final-export': ['premiere-pro', 'ffmpeg']
};

export function validateStageApproval({ projectId, runId, stage, approval, now = Date.now() } = {}) {
  if (!APPROVAL_STAGES.has(stage)) return { valid: false, reason: 'This stage does not accept an Adobe production approval.' };
  if (!projectId || !runId || !approval || typeof approval !== 'object') return { valid: false, reason: 'A project-scoped approval record is required.' };
  if (approval.approved !== true) return { valid: false, reason: 'Approval has not been granted.' };
  if (approval.projectId !== projectId || approval.runId !== runId || approval.stage !== stage) return { valid: false, reason: 'Approval scope does not match this project, run and stage.' };
  if (typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()) return { valid: false, reason: 'Approval actor is required.' };
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= approvedAt) return { valid: false, reason: 'Approval timestamps are invalid.' };
  if (approvedAt > now || expiresAt <= now) return { valid: false, reason: 'Approval is not currently valid.' };
  return { valid: true, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt };
}

export function authorizeProductionStage({ projectId, runId, stage, hostReadiness, approval, now = Date.now() } = {}) {
  if (hostReadiness?.ready !== true || !Array.isArray(hostReadiness.checks) || hostReadiness.checks.length === 0 || hostReadiness.checks.some(check => check.ready !== true) || (Array.isArray(hostReadiness.missing) && hostReadiness.missing.length > 0)) {
    return { authorized: false, reason: 'A successful host-readiness report is required.' };
  }
  const requiredEngines = STAGE_ENGINES[stage] || [];
  const readyEngines = new Set(hostReadiness.checks.filter(check => check.ready === true).map(check => check.engine));
  const missing = requiredEngines.filter(engine => !readyEngines.has(engine));
  if (missing.length) return { authorized: false, reason: 'Required stage hosts are not verified: ' + missing.join(', ') + '.' };
  const result = validateStageApproval({ projectId, runId, stage, approval, now });
  return result.valid ? { authorized: true, approval: { approvedBy: result.approvedBy, approvedAt: result.approvedAt, expiresAt: result.expiresAt }, hostEvidence: requiredEngines } : { authorized: false, reason: result.reason };
}

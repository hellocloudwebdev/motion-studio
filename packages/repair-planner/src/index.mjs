import { createHash } from 'node:crypto';

const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
const stableId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function buildRepairPlan({
  projectId, runId, defects = [], cycle = 0, maxCycles = 2, maxTasks = 24
} = {}) {
  if (!projectId || !runId) throw new Error('Repair planning requires projectId and runId.');
  if (!Number.isInteger(cycle) || cycle < 0 || !Number.isInteger(maxCycles) || maxCycles < 0) throw new Error('Repair cycle limits must be non-negative integers.');
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error('maxTasks must be a positive integer.');
  if (!Array.isArray(defects)) throw new Error('defects must be an array.');
  if (cycle >= maxCycles) return {
    status: 'escalation-required',
    projectId, runId, cycle, maxCycles, tasks: [],
    escalations: [{ code: 'REPAIR_CYCLE_LIMIT', message: 'Repair cycle budget exhausted; human intervention is required.' }]
  };

  const groups = new Map(), escalations = [];
  for (const defect of defects) {
    if (!defect || typeof defect.defectId !== 'string' || !defect.defectId || !SEVERITY.has(defect.severity)) {
      escalations.push({ code: 'INVALID_DEFECT', defectId: defect?.defectId || null, message: 'Defect is missing a stable id or supported severity.' });
      continue;
    }
    if (defect.severity === 'low' || defect.retestRequired === false) continue;
    if (!defect.sceneId || typeof defect.repairOwner !== 'string' || !defect.repairOwner) {
      escalations.push({ code: 'REPAIR_SCOPE_UNRESOLVED', defectId: defect.defectId, message: 'Defect has no scene or repair owner; automatic repair is not safe.' });
      continue;
    }
    const range = defect.timeRangeFrames;
    if (range !== null && range !== undefined && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start)) {
      escalations.push({ code: 'INVALID_FRAME_RANGE', defectId: defect.defectId, message: 'Defect frame range is invalid; automatic repair is not safe.' });
      continue;
    }
    const key = [defect.sceneId, defect.repairOwner, defect.category || 'general'].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(defect);
  }

  const tasks = [...groups.entries()].map(([groupKey, items]) => {
    const first = items[0];
    const ranges = items.map(item => item.timeRangeFrames).filter(Boolean).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
      else merged.push({ start: range.start, end: range.end });
    }
    const defectIds = items.map(item => item.defectId).sort();
    const id = 'repair-' + stableId({ projectId, runId, cycle, groupKey, defectIds });
    return {
      id, projectId, runId, cycle, sceneId: first.sceneId, owner: first.repairOwner,
      category: first.category || 'general', defectIds,
      timeRanges: merged,
      approvalRequired: items.some(item => item.severity === 'critical' || item.autonomousRepairAllowed !== true),
      requiredRetests: defectIds,
      status: 'proposed'
    };
  }).sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.owner.localeCompare(b.owner));

  if (tasks.length > maxTasks) {
    escalations.push({ code: 'REPAIR_TASK_BUDGET_EXCEEDED', message: 'Repair plan exceeds the configured task budget.' });
    return { status: 'escalation-required', projectId, runId, cycle, maxCycles, tasks: [], escalations };
  }
  return {
    status: escalations.length ? 'needs-review' : (tasks.length ? 'ready' : 'no-repairs'),
    projectId, runId, cycle, maxCycles, tasks, escalations
  };
}

export function evaluateRepairOutcome(task, outcome) {
  if (!task || !task.id || !Array.isArray(task.requiredRetests)) throw new Error('A valid repair task is required.');
  if (!outcome || outcome.taskId !== task.id) throw new Error('Repair outcome does not match the planned task.');
  const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : [];
  const retests = Array.isArray(outcome.retests) ? outcome.retests : [];
  const passedRetests = new Set(retests.filter(item => item && item.passed === true).map(item => item.defectId));
  const missingRetests = task.requiredRetests.filter(id => !passedRetests.has(id));
  const verifiedEvidence = evidence.filter(item => item && typeof item.ref === 'string' && item.ref && item.verified === true);
  const verified = outcome.status === 'completed' && outcome.verified === true && missingRetests.length === 0 && verifiedEvidence.length > 0;
  return {
    taskId: task.id,
    status: verified ? 'verified' : 'blocked',
    verified,
    missingRetests,
    evidence: verifiedEvidence,
    reason: verified ? null : 'Repair requires a verified result, evidence reference and passing retest for every linked defect.'
  };
}

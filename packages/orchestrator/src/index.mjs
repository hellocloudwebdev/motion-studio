import { authorizeProductionStage } from './host-readiness.mjs';

export { loadQualityGates } from './quality-gates.mjs';
export { defaultRunState, loadRunState, saveRunState, runStatePath, invalidateOnInputChange, computeRepairCyclesFromLedger } from './run-state.mjs';

const TRANSITIONS = {
  draft: new Set(['planned', 'cancelled']), planned: new Set(['rendering', 'cancelled', 'failed']),
  rendering: new Set(['qa', 'failed']), qa: new Set(['repair', 'assembling', 'failed']),
  repair: new Set(['rendering', 'failed']), assembling: new Set(['exporting', 'failed']),
  exporting: new Set(['delivered', 'failed']), delivered: new Set(), failed: new Set(['planned', 'cancelled']), cancelled: new Set()
};

export function createProductionRun({ id, projectId, maxRepairCycles = 2 } = {}) {
  if (!id || !projectId) throw new Error('Run id and projectId are required.');
  if (!Number.isInteger(maxRepairCycles) || maxRepairCycles < 0) throw new Error('maxRepairCycles must be a non-negative integer.');
  return { id, projectId, status: 'draft', revision: 0, repairCycles: 0, maxRepairCycles, artifacts: [], approvals: [], events: [{ revision: 0, from: null, to: 'draft', at: new Date().toISOString(), metadata: {} }] };
}
export function transitionRun(run, nextStatus, metadata = {}) {
  if (!run || !TRANSITIONS[run.status]) throw new Error('Invalid production run state.');
  if (!TRANSITIONS[run.status].has(nextStatus)) throw new Error(`Illegal run transition: ${run.status} -> ${nextStatus}.`);
  if (nextStatus === 'repair' && run.repairCycles >= run.maxRepairCycles) throw new Error(`Repair limit reached (${run.maxRepairCycles}). Fail the run or request human intervention.`);
  const approvalStage = nextStatus === 'assembling' ? 'premiere-assembly' : nextStatus === 'exporting' ? 'final-export' : null;
  if (approvalStage) {
    const authorization = authorizeProductionStage({
      projectId: run.projectId, runId: run.id, stage: approvalStage,
      hostReadiness: metadata.hostReadiness, approval: metadata.approval
    });
    if (!authorization.authorized) throw new Error(`Cannot enter ${nextStatus}: ${authorization.reason}`);
  }
  if (nextStatus === 'delivered' && !run.artifacts.some(x => x.kind === 'final-export' && x.verified === true)) throw new Error('Cannot mark delivered without a verified final-export artifact.');
  const next = structuredClone(run);
  if (nextStatus === 'repair') next.repairCycles += 1;
  if (approvalStage) next.approvals.push({ stage: approvalStage, ...structuredClone(metadata.approval) });
  next.revision += 1; next.status = nextStatus;
  next.events.push({ revision: next.revision, from: run.status, to: nextStatus, at: new Date().toISOString(), metadata: structuredClone(metadata) });
  return next;
}
export function recordArtifact(run, artifact) {
  if (!run || !artifact || !artifact.id || !artifact.kind) throw new Error('Run, artifact id and artifact kind are required.');
  if (['delivered', 'cancelled'].includes(run.status)) throw new Error(`Cannot add artifacts to a ${run.status} run.`);
  const next = structuredClone(run);
  if (next.artifacts.some(x => x.id === artifact.id)) throw new Error(`Duplicate artifact id: ${artifact.id}`);
  next.artifacts.push({ ...structuredClone(artifact), recordedAt: new Date().toISOString() });
  next.revision += 1; next.events.push({ revision: next.revision, from: run.status, to: run.status, at: new Date().toISOString(), metadata: { event: 'artifact-recorded', artifactId: artifact.id } });
  return next;
}
export function buildExecutionGraph(routePlan) {
  const nodes = [], edges = [], sceneComposeIds = [];
  for (const scene of routePlan.plans || []) {
    const renderIds = [];
    for (const task of scene.tasks || []) { nodes.push({ id: task.taskId, kind: 'scene-render', sceneId: scene.sceneId, engine: task.engine, layerIds: task.layerIds }); renderIds.push(task.taskId); }
    const composeId = `${scene.sceneId}:compose`; nodes.push({ id: composeId, kind: 'scene-compose', sceneId: scene.sceneId, engine: 'scene-compositor' });
    for (const renderId of renderIds) edges.push({ from: renderId, to: composeId });
    sceneComposeIds.push(composeId);
  }
  const assemblyId = 'timeline:premiere-assembly'; nodes.push({ id: assemblyId, kind: 'editorial-assembly', engine: 'premiere-pro', requiresApproval: true });
  for (const id of sceneComposeIds) edges.push({ from: id, to: assemblyId });
  const deliveryId = 'delivery:ffmpeg'; nodes.push({ id: deliveryId, kind: 'delivery', engine: 'ffmpeg', requiresApproval: true }); edges.push({ from: assemblyId, to: deliveryId });
  return { nodes, edges, executionPolicy: { ...(routePlan.executionPolicy || {}), maxWorkers: 1, requireVerifiedHosts: true, requireStageApprovals: true } };
}
export function validateExecutionGraph(graph) {
  const ids = new Set((graph.nodes || []).map(x => x.id)), indegree = new Map([...ids].map(id => [id, 0])), adjacency = new Map([...ids].map(id => [id, []])), errors = [];
  for (const edge of graph.edges || []) { if (!ids.has(edge.from) || !ids.has(edge.to)) { errors.push({ code: 'UNKNOWN_NODE', edge }); continue; } adjacency.get(edge.from).push(edge.to); indegree.set(edge.to, indegree.get(edge.to) + 1); }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id); let visited = 0;
  while (queue.length) { const id = queue.shift(); visited += 1; for (const next of adjacency.get(id)) { indegree.set(next, indegree.get(next) - 1); if (indegree.get(next) === 0) queue.push(next); } }
  if (visited !== ids.size) errors.push({ code: 'DEPENDENCY_CYCLE', message: 'Execution graph contains a dependency cycle.' });
  return { valid: errors.length === 0, errors, nodeCount: ids.size, edgeCount: (graph.edges || []).length };
}

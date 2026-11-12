import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Per-project run state (projects/<id>/run-state.json). The state tracks the
// current run, the input hashes it was produced from, the repair policy in
// force and the repair-cycle ledger. Any change to the project IR or project
// file invalidates unverified work and resets the run to 'planned'.

const RUN_STATE_SCHEMA_VERSION = 1;

export function runStatePath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') throw new Error('A project workspace directory is required.');
  return path.join(projectRoot, 'run-state.json');
}

export function defaultRunState({ projectId, runId = null, policy = null } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('A non-empty projectId is required.');
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    projectId,
    runId,
    status: 'planned',
    revision: 0,
    repairCycles: 0,
    inputs: { projectIrSha256: null, projectFileSha256: null, recordedAt: null },
    policy: policy && typeof policy === 'object' && !Array.isArray(policy) ? structuredClone(policy) : null,
    artifacts: [],
    events: [],
    updatedAt: new Date().toISOString()
  };
}

export async function loadRunState(projectRoot) {
  const file = runStatePath(projectRoot);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Run state is not valid JSON (' + file + '): ' + error.message);
  }
}

// Atomic save: write to a unique temp file in the same directory, then rename
// over the target so readers never observe a partial run state.
export async function saveRunState(projectRoot, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('A run state object is required.');
  const file = runStatePath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(temp, file);
  return state;
}

// Called before work starts: if either input hash differs from what the state
// recorded, the state resets to 'planned', unverified artifacts are dropped and
// the ledger and events are preserved. Matching inputs return the same state.
export function invalidateOnInputChange(state, { projectIrSha256, projectFileSha256 } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('A persisted run state object is required.');
  const inputs = state.inputs && typeof state.inputs === 'object' ? state.inputs : {};
  const irChanged = projectIrSha256 !== undefined && projectIrSha256 !== inputs.projectIrSha256;
  const fileChanged = projectFileSha256 !== undefined && projectFileSha256 !== inputs.projectFileSha256;
  if (!irChanged && !fileChanged) return state;
  const next = structuredClone(state);
  const droppedArtifacts = (Array.isArray(next.artifacts) ? next.artifacts : []).filter(artifact => !artifact || artifact.verified !== true).map(artifact => artifact?.id ?? null);
  next.inputs = {
    projectIrSha256: irChanged ? projectIrSha256 : inputs.projectIrSha256 ?? null,
    projectFileSha256: fileChanged ? projectFileSha256 : inputs.projectFileSha256 ?? null,
    recordedAt: new Date().toISOString()
  };
  next.artifacts = (Array.isArray(next.artifacts) ? next.artifacts : []).filter(artifact => artifact && artifact.verified === true);
  next.revision = (Number.isInteger(next.revision) ? next.revision : 0) + 1;
  next.events = [
    ...(Array.isArray(next.events) ? next.events : []),
    {
      revision: next.revision, from: state.status ?? null, to: 'planned', at: new Date().toISOString(),
      type: 'inputs-invalidated',
      metadata: { projectIrSha256: next.inputs.projectIrSha256, projectFileSha256: next.inputs.projectFileSha256, droppedArtifacts }
    }
  ];
  next.status = 'planned';
  next.updatedAt = new Date().toISOString();
  return next;
}

// Repair cycles consumed by a run: one ledger entry per executed repair cycle
// (a QA record whose repair plan required repair), keyed by run id.
export function computeRepairCyclesFromLedger(project, runId) {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('A non-empty runId is required to compute repair cycles.');
  const history = Array.isArray(project?.qa?.repairHistory) ? project.qa.repairHistory : [];
  return history.filter(entry => entry && entry.runId === runId && entry.status === 'repair-required').length;
}

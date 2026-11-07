import { createHash } from 'node:crypto';

const VALID_STATUSES = new Set(['completed', 'blocked', 'failed']);
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const clone = value => structuredClone(value);

function validateResult(result) {
  if (!result || typeof result !== 'object' || !VALID_STATUSES.has(result.status)) {
    throw new Error('Agent result must have status completed, blocked or failed.');
  }
  for (const field of ['artifacts', 'findings', 'proposals']) {
    if (result[field] !== undefined && !Array.isArray(result[field])) throw new Error('Agent result ' + field + ' must be an array.');
  }
  for (const artifact of result.artifacts || []) {
    if (!artifact || typeof artifact.id !== 'string' || !artifact.id || typeof artifact.kind !== 'string' || !artifact.kind) {
      throw new Error('Every agent artifact requires a non-empty id and kind.');
    }
    if (artifact.verified === true && (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256))) {
      throw new Error('Verified agent artifacts require a SHA-256 checksum.');
    }
  }
  return clone({
    status: result.status,
    summary: typeof result.summary === 'string' ? result.summary : '',
    artifacts: result.artifacts || [],
    findings: result.findings || [],
    proposals: result.proposals || [],
    evidence: result.evidence || [],
    metadata: result.metadata || {}
  });
}

export function createAgentRegistry() {
  const agents = new Map();
  const idempotency = new Map();
  return {
    register(agent) {
      if (!agent || typeof agent.role !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(agent.role)) throw new Error('Agent role must be a stable lowercase role identifier.');
      if (typeof agent.version !== 'string' || !/^\d+\.\d+\.\d+/.test(agent.version)) throw new Error('Agent version must be semver-like.');
      if (!Array.isArray(agent.capabilities) || agent.capabilities.some(x => typeof x !== 'string' || !x)) throw new Error('Agent capabilities must be a string array.');
      if (typeof agent.execute !== 'function') throw new Error('Agent execute function is required.');
      if (agents.has(agent.role)) throw new Error('Agent role already registered: ' + agent.role);
      agents.set(agent.role, Object.freeze({
        role: agent.role,
        version: agent.version,
        capabilities: Object.freeze([...new Set(agent.capabilities)]),
        execute: agent.execute
      }));
      return this;
    },
    get(role) { return agents.get(role) || null; },
    roles() { return [...agents.keys()].sort(); },
    _idempotency: idempotency
  };
}

export async function dispatchAgentTask(registry, task, {
  projectId,
  allowedCapabilities = [],
  timeoutMs = 120000
} = {}) {
  if (!registry?._idempotency || !task || typeof task !== 'object') throw new Error('A valid registry and task are required.');
  for (const field of ['id', 'runId', 'projectId', 'role', 'idempotencyKey']) {
    if (typeof task[field] !== 'string' || !task[field]) throw new Error('Agent task requires ' + field + '.');
  }
  if (!projectId || task.projectId !== projectId) throw new Error('Project boundary violation: task project does not match execution context.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeoutMs must be between 1 ms and 1 hour.');
  const agent = registry.get(task.role);
  if (!agent) throw new Error('No agent registered for role: ' + task.role);
  const granted = new Set(allowedCapabilities);
  const agentCapabilities = new Set(agent.capabilities);
  const required = task.requiredCapabilities || [];
  if (!Array.isArray(required) || required.some(capability => typeof capability !== 'string')) throw new Error('requiredCapabilities must be a string array.');
  for (const capability of required) {
    if (!granted.has(capability) || !agentCapabilities.has(capability)) throw new Error('Capability denied: ' + capability);
  }
  const payloadHash = digest({ payload: task.payload ?? null, role: task.role, required });
  const key = [task.projectId, task.runId, task.role, task.idempotencyKey].join(':');
  const previous = registry._idempotency.get(key);
  if (previous) {
    if (previous.payloadHash !== payloadHash) throw new Error('Idempotency key reused with different task input.');
    if (previous.state === 'completed') return clone(previous.result);
    if (previous.state === 'running') return previous.promise;
    throw new Error('Task side-effect outcome is uncertain; reconcile before retrying.');
  }

  const controller = new AbortController();
  const record = { payloadHash, state: 'running', result: null, promise: null };
  registry._idempotency.set(key, record);
  const executionContext = Object.freeze({
    projectId: task.projectId,
    runId: task.runId,
    taskId: task.id,
    grantedCapabilities: Object.freeze(required.slice()),
    signal: controller.signal
  });
  const payload = clone(task.payload ?? {});
  const work = Promise.resolve().then(() => agent.execute(payload, executionContext)).then(validateResult);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Agent task deadline exceeded.'));
      const error = new Error('Agent task timed out; external side effects must be reconciled before retry.');
      error.code = 'AGENT_TIMEOUT_RECONCILIATION_REQUIRED';
      reject(error);
    }, timeoutMs);
  });
  record.promise = Promise.race([work, timeout]).then(result => {
    record.state = 'completed';
    record.result = result;
    record.promise = null;
    return clone(result);
  }).catch(error => {
    record.state = error.code === 'AGENT_TIMEOUT_RECONCILIATION_REQUIRED' ? 'uncertain' : 'uncertain';
    record.promise = null;
    throw error;
  }).finally(() => clearTimeout(timer));
  return record.promise;
}

export function reconcileAgentTask(registry, {
  projectId, runId, role, idempotencyKey, outcome, result
} = {}) {
  if (!registry?._idempotency) throw new Error('A valid agent registry is required.');
  const key = [projectId, runId, role, idempotencyKey].join(':');
  const record = registry._idempotency.get(key);
  if (!record || record.state !== 'uncertain') throw new Error('Only an uncertain task can be reconciled.');
  if (outcome === 'completed') {
    record.result = validateResult(result);
    record.state = 'completed';
    return clone(record.result);
  }
  if (outcome === 'not-executed') {
    registry._idempotency.delete(key);
    return { reconciled: true, retryAllowed: true };
  }
  throw new Error('Reconciliation outcome must be completed or not-executed.');
}

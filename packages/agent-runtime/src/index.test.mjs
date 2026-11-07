import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRegistry, dispatchAgentTask, reconcileAgentTask } from './index.mjs';

const task = overrides => ({
  id: 'task-1', runId: 'run-1', projectId: 'project-1', role: 'script-writer',
  idempotencyKey: 'task-1-v1', requiredCapabilities: ['project:read'],
  payload: { brief: 'A 30 second product film' }, ...overrides
});

test('dispatch enforces project and capability boundaries', async () => {
  const registry = createAgentRegistry().register({
    role: 'script-writer', version: '1.0.0', capabilities: ['project:read'],
    execute: async () => ({ status: 'completed' })
  });
  await assert.rejects(dispatchAgentTask(registry, task(), { projectId: 'other', allowedCapabilities: ['project:read'] }), /Project boundary/);
  await assert.rejects(dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: [] }), /Capability denied/);
});

test('duplicate task submissions return the same completed result without re-execution', async () => {
  let calls = 0;
  const registry = createAgentRegistry().register({
    role: 'script-writer', version: '1.0.0', capabilities: ['project:read'],
    execute: async () => { calls += 1; return { status: 'completed', summary: 'Storyboard ready' }; }
  });
  const first = await dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: ['project:read'] });
  const second = await dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: ['project:read'] });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('idempotency key cannot be reused with different input', async () => {
  const registry = createAgentRegistry().register({
    role: 'script-writer', version: '1.0.0', capabilities: ['project:read'],
    execute: async payload => ({ status: 'completed', summary: payload.brief })
  });
  await dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: ['project:read'] });
  await assert.rejects(dispatchAgentTask(registry, task({ payload: { brief: 'Different brief' } }), { projectId: 'project-1', allowedCapabilities: ['project:read'] }), /reused with different/);
});

test('agent timeout becomes uncertain and requires explicit reconciliation', async () => {
  const registry = createAgentRegistry().register({
    role: 'script-writer', version: '1.0.0', capabilities: ['project:read'],
    execute: async () => new Promise(resolve => setTimeout(() => resolve({ status: 'completed' }), 30))
  });
  await assert.rejects(dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: ['project:read'], timeoutMs: 5 }), error => error.code === 'AGENT_TIMEOUT_RECONCILIATION_REQUIRED');
  await assert.rejects(dispatchAgentTask(registry, task(), { projectId: 'project-1', allowedCapabilities: ['project:read'] }), /reconcile before retrying/);
  const reconciled = reconcileAgentTask(registry, {
    projectId: 'project-1', runId: 'run-1', role: 'script-writer', idempotencyKey: 'task-1-v1',
    outcome: 'completed', result: { status: 'completed', summary: 'Recovered' }
  });
  assert.equal(reconciled.summary, 'Recovered');
});

test('verified artifacts require SHA-256 evidence', async () => {
  const registry = createAgentRegistry().register({
    role: 'script-writer', version: '1.0.0', capabilities: [],
    execute: async () => ({ status: 'completed', artifacts: [{ id: 'a1', kind: 'video', verified: true }] })
  });
  await assert.rejects(dispatchAgentTask(registry, task({ requiredCapabilities: [] }), { projectId: 'project-1' }), /SHA-256/);
});

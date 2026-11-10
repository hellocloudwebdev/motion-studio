import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdobeMcpEnvironment, resolveAdobeMcpEntries, createAdobeOperationApproval, validateAdobeOperationApproval } from './index.mjs';

test('After Effects starts read-only and arbitrary ExtendScript remains disabled', () => {
  const env = createAdobeMcpEnvironment({ app: 'afterEffects', baseEnv: { PATH: '/bin', AE_MCP_ENABLE_EVAL: '1' } });
  assert.equal(env.AE_MCP_READONLY, '1');
  assert.equal('AE_MCP_ENABLE_EVAL' in env, false);
  assert.equal(env.PATH, '/bin');
});

test('Premiere starts with inspect authority only', () => {
  const env = createAdobeMcpEnvironment({ app: 'premiere', baseEnv: { PREMIERE_MCP_CAPABILITIES: 'unsafe-script' } });
  assert.equal(env.PREMIERE_MCP_CAPABILITIES, 'inspect');
  assert.equal(env.PREMIERE_MCP_TOOL_PACKS, 'inspection');
});

test('edit mode never enables unsafe-script', () => {
  const ae = createAdobeMcpEnvironment({ app: 'afterEffects', allowEdits: true });
  const pr = createAdobeMcpEnvironment({ app: 'premiere', allowEdits: true });
  assert.equal(ae.AE_MCP_READONLY, '0');
  assert.equal('AE_MCP_ENABLE_EVAL' in ae, false);
  assert.equal(pr.PREMIERE_MCP_CAPABILITIES, 'inspect,edit,export,filesystem');
  assert.equal(pr.PREMIERE_MCP_CAPABILITIES.includes('unsafe-script'), false);
});

test('entry resolver resolves exact upstream package executables', () => {
  const entries = resolveAdobeMcpEntries({ resolve: name => '/node_modules/' + name + '/dist/index.js' });
  assert.match(entries.afterEffects, /mcp-aftereffects/);
  assert.match(entries.premiere, /premiere-pro-mcp/);
});

test('Adobe operation approval is scoped to exact project, run, tool and arguments', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const args = { sequenceId: 'seq-1', export: { format: 'h264', width: 1920 } };
  const approval = createAdobeOperationApproval({ projectId: 'p1', runId: 'r1', app: 'premiere', toolName: 'export_sequence', args, approvedBy: 'producer', now });
  assert.equal(validateAdobeOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'premiere', toolName: 'export_sequence', args, now }).valid, true);
  assert.equal(validateAdobeOperationApproval({ approval, projectId: 'p2', runId: 'r1', app: 'premiere', toolName: 'export_sequence', args, now }).valid, false);
  assert.equal(validateAdobeOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'premiere', toolName: 'export_sequence', args: { sequenceId: 'other' }, now }).valid, false);
  assert.equal(validateAdobeOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'premiere', toolName: 'export_sequence', args, now: now + 600001 }).valid, false);
});

test('Adobe operation approval requires an identified approver and bounded expiry', () => {
  assert.throws(() => createAdobeOperationApproval({ projectId: 'p1', runId: 'r1', app: 'afterEffects', toolName: 'save_project', approvedBy: '' }), /approving actor/);
  assert.throws(() => createAdobeOperationApproval({ projectId: 'p1', runId: 'r1', app: 'afterEffects', toolName: 'save_project', approvedBy: 'producer', expiresInMs: 7200000 }), /between 1 ms and 1 hour/);
});

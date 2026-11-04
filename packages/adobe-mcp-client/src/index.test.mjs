import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdobeMcpEnvironment, resolveAdobeMcpEntries } from './index.mjs';

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
  assert.equal(ae.AE_MCP_ALLOW_CATEGORIES, 'comp,layer,text,transform,keyframe,render');
  assert.equal('AE_MCP_ENABLE_EVAL' in ae, false);
  assert.equal(pr.PREMIERE_MCP_CAPABILITIES, 'inspect,edit,export,filesystem');
  assert.match(pr.PREMIERE_MCP_TOOL_LIST, /create_sequence_from_clips/);
  assert.equal(pr.PREMIERE_MCP_CAPABILITIES.includes('unsafe-script'), false);
});

test('entry resolver resolves exact upstream package executables', () => {
  const entries = resolveAdobeMcpEntries({ resolve: name => '/node_modules/' + name + '/dist/index.js' });
  assert.match(entries.afterEffects, /mcp-aftereffects/);
  assert.match(entries.premiere, /premiere-pro-mcp/);
});

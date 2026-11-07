import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHostReadiness, authorizeProductionStage, validateStageApproval } from './host-readiness.mjs';

const route = { plans: [{ tasks: [{ engine: 'hyperframes' }, { engine: 'after-effects' }] }] };
const checks = {
  hyperframes: { available: true },
  afterEffects: { serverConnected: true, contextAvailable: true },
  premiere: { serverConnected: true, hostVerified: true },
  ffmpeg: { available: true }
};

test('host readiness requires explicit evidence for every routed engine and delivery stage', () => {
  const result = evaluateHostReadiness(route, checks);
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  const partial = evaluateHostReadiness(route, { ...checks, afterEffects: { serverConnected: true } });
  assert.equal(partial.ready, false);
  assert.ok(partial.missing.includes('after-effects'));
});

test('unknown engines fail closed instead of being treated as available', () => {
  const result = evaluateHostReadiness({ plans: [{ tasks: [{ engine: 'unknown-engine' }] }] }, checks);
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('unknown-engine'));
});

test('Adobe stage authorization requires host verification and matching live approval', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const approval = {
    approved: true, projectId: 'p1', runId: 'r1', stage: 'premiere-assembly',
    approvedBy: 'producer', approvedAt: '2026-11-07T11:59:00.000Z', expiresAt: '2026-11-07T12:10:00.000Z'
  };
  assert.equal(authorizeProductionStage({ projectId: 'p1', runId: 'r1', stage: 'premiere-assembly', hostReady: true, approval, now }).authorized, true);
  assert.equal(authorizeProductionStage({ projectId: 'p2', runId: 'r1', stage: 'premiere-assembly', hostReady: true, approval, now }).authorized, false);
  assert.equal(authorizeProductionStage({ projectId: 'p1', runId: 'r1', stage: 'premiere-assembly', hostReady: false, approval, now }).authorized, false);
  assert.equal(validateStageApproval({ projectId: 'p1', runId: 'r1', stage: 'premiere-assembly', approval, now: Date.parse('2026-11-07T12:11:00.000Z') }).valid, false);
});

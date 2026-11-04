import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAfterEffectsScenePlan,
  createApprovalStore,
  parseMcpPayload,
  unwrapMcpData,
  validateDeclaredOperationArgs,
  validatePremiereRenderInputs,
  validateAePlanAgainstCatalog
} from './index.mjs';

const project = {
  schemaVersion: '1.0.0',
  project: { id: 'demo', name: 'Demo', objective: 'Test', revision: 2, frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080 }, totalDurationFrames: 90 },
  creative: { concept: 'Test', audience: 'Test audience', message: 'Test message' },
  brand: { colors: { background: '#171717' } },
  assets: [],
  scenes: [{ id: 'scene-1', name: 'Opening', intent: 'Title', durationFrames: 90, layers: [
    { id: 'headline', kind: 'text', content: { text: 'Hello' }, transform: { x: 100, y: 200, width: 900, height: 160 }, typography: { sizePx: 92, weight: 800, alignment: 'left' }, style: { color: '#fff8ee' } },
    { id: 'backplate', kind: 'shape', transform: { x: 80, y: 180, width: 940, height: 210 }, style: { backgroundColor: '#f5a623', opacity: 0.8 } },
    { id: 'hero', kind: 'image', assetId: 'hero', engineHint: 'hyperframes' }
  ] }],
  delivery: { targets: [{ id: 'master', format: 'mp4', width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] }
};

test('After Effects scene plan maps editable text/shape and warns on non-AE layers', () => {
  const plan = buildAfterEffectsScenePlan(project, 'scene-1');
  assert.equal(plan.operations[0].operation, 'comp.create');
  assert.equal(plan.operations.filter(x => x.operation === 'layer.create_text').length, 1);
  assert.equal(plan.operations.filter(x => x.operation === 'layer.create_solid').length, 1);
  assert.equal(plan.supportedLayerIds.length, 2);
  assert.equal(plan.warnings[0].code, 'AE_LAYER_UNSUPPORTED');
  assert.equal(plan.composition.duration, 3);
});

test('approval token is single-use and expires', () => {
  let now = 1000;
  const store = createApprovalStore({ ttlMs: 50, now: () => now });
  const token = store.issue({ planHash: 'abc' });
  assert.equal(store.consume(token.approvalId).planHash, 'abc');
  assert.throws(() => store.consume(token.approvalId), /unknown or has already been consumed/);
  const expired = store.issue({ planHash: 'def' });
  now += 51;
  assert.throws(() => store.consume(expired.approvalId), /expired/);
});

test('parses JSON MCP text and rejects MCP error envelopes', () => {
  assert.deepEqual(parseMcpPayload({ content: [{ type: 'text', text: '{"success":true,"data":{"count":2}}' }] }), { success: true, data: { count: 2 } });
  assert.throws(() => parseMcpPayload({ isError: true }), /isError/);
  assert.deepEqual(unwrapMcpData({ success: true, data: { count: 2 } }), { count: 2 });
  assert.throws(() => unwrapMcpData({ success: false, error: 'refused' }), /refused/);
});

test('validates declared AE operation argument schemas from the live catalog', () => {
  const definition = { name: 'comp.create', params: [
    { name: 'name', type: 'string', required: true },
    { name: 'width', type: 'number', required: true }
  ] };
  assert.equal(validateDeclaredOperationArgs(definition, { name: 'Test', width: 1920 }), true);
  assert.throws(() => validateDeclaredOperationArgs(definition, { name: 'Test', width: '1920' }), /must be number/);
  assert.throws(() => validateDeclaredOperationArgs(definition, { name: 'Test', width: 1920, eval: 'x' }), /undeclared/);
});

test('rejects operations not in the local AE allowlist even if the host catalog advertises them', () => {
  const plan = { operations: [{ operation: 'eval.run', args: {} }] };
  assert.throws(() => validateAePlanAgainstCatalog(plan, [{ operations: [{ name: 'eval.run', params: [] }] }]), /outside Motion Studio allowlist/);
});

test('Premiere render inputs must be absolute and unique', () => {
  assert.throws(() => validatePremiereRenderInputs(['relative.mp4']), /absolute/);
  assert.throws(() => validatePremiereRenderInputs(['/tmp/a.mp4', '/tmp/a.mp4']), /Duplicate/);
  assert.deepEqual(validatePremiereRenderInputs(['/tmp/a.mp4']), ['/tmp/a.mp4']);
});

test('backup path must be distinct, same-extension, contained in an existing directory and non-colliding', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-adobe-'));
  try {
    const source = path.join(dir, 'project.aep');
    const backup = path.join(dir, 'project-backup.aep');
    await writeFile(source, 'fixture');
    const { assertNewBackupPath } = await import('./index.mjs');
    assert.equal(await assertNewBackupPath(backup, source, 'backup'), backup);
    await assert.rejects(() => assertNewBackupPath(source, source, 'backup'), /must differ/);
    await assert.rejects(() => assertNewBackupPath(path.join(dir, 'backup.prproj'), source, 'backup'), /same file extension/);
    await writeFile(backup, 'already exists');
    await assert.rejects(() => assertNewBackupPath(backup, source, 'backup'), /already exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

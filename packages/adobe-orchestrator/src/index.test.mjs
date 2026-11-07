import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAfterEffectsScenePlan,
  previewAfterEffectsScene,
  applyAfterEffectsScene,
  previewPremiereAssembly,
  applyPremiereAssembly,
  createApprovalStore,
  parseMcpPayload,
  unwrapMcpData,
  validateDeclaredOperationArgs,
  validatePremiereRenderInputs,
  validateAePlanAgainstCatalog,
  acquireHostMutationLock,
  defaultAdobeReceiptDirectory
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

const asMcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const aeToolNames = ['ae_context','ae_project_info','ae_catalog','ae_do','ae_save_project','ae_comp_info','ae_render_frame'];
const prToolNames = ['verify_premiere_connection','get_project_info','import_media','create_sequence_from_clips','get_active_sequence','get_sequence_structure','save_project','export_sequence','verify_delivery_file'];

function aeCatalogOperations(category) {
  const required = names => names.map(name => ({ name, type: 'string', required: true }));
  if (category === 'comp') return [{ name: 'comp.create', params: [
    ...required(['name']), { name: 'width', type: 'number', required: true }, { name: 'height', type: 'number', required: true },
    { name: 'fps', type: 'number', required: true }, { name: 'duration', type: 'number', required: true }, { name: 'bgColor', type: 'array', required: false }
  ] }];
  if (category === 'layer') return [
    { name: 'layer.create_text', params: [{ name: 'comp', type: 'string', required: true },{ name: 'text', type: 'string', required: true },{ name: 'name', type: 'string' },{ name: 'boxSize', type: 'array' },{ name: 'boxPosition', type: 'array' },{ name: 'orientation', type: 'string' }] },
    { name: 'layer.create_solid', params: [{ name: 'comp', type: 'string', required: true },{ name: 'name', type: 'string' },{ name: 'color', type: 'array' },{ name: 'width', type: 'number' },{ name: 'height', type: 'number' }] }
  ];
  if (category === 'text') return [{ name: 'text.set_style', params: [{ name: 'comp', type: 'string', required: true },{ name: 'layer', type: 'string', required: true },{ name: 'fontSize', type: 'number' },{ name: 'fillColor', type: 'array' },{ name: 'justification', type: 'string' }] }];
  if (category === 'transform') return [{ name: 'transform.set', params: [{ name: 'comp', type: 'string', required: true },{ name: 'layer', type: 'string', required: true },{ name: 'position', type: 'array' },{ name: 'opacity', type: 'number' }] }];
  if (category === 'keyframe') return [{ name: 'keyframe.add', params: [{ name: 'comp', type: 'string', required: true },{ name: 'layer', type: 'string', required: true },{ name: 'property', type: 'array', required: true },{ name: 'time', type: 'number', required: true },{ name: 'value', type: 'any', required: true }] }];
  return [];
}

test('After Effects workflow previews without mutation, then applies with backup and frame evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-ae-flow-'));
  try {
    const projectFile = path.join(dir, 'test.aep');
    const backupPath = path.join(dir, 'test-backup.aep');
    await writeFile(projectFile, 'saved-ae-project');
    const calls = [];
    const makeConnection = () => ({
      async listTools() { return { tools: aeToolNames.map(name => ({ name })) }; },
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'ae_context') return asMcp({ instance: 'ae-local' });
        if (name === 'ae_project_info') return asMcp({ file: projectFile, dirty: false, items: [] });
        if (name === 'ae_catalog') return asMcp({ category: args.category, operations: aeCatalogOperations(args.category) });
        if (name === 'ae_do') return asMcp({ result: { ok: true, operation: args.operation }, context: {} });
        if (name === 'ae_save_project') return asMcp({ saved: true, path: projectFile });
        if (name === 'ae_comp_info') return asMcp({ ok: true, found: true, name: args.nameOrId, layers: [{ name: 'MS_headline' },{ name: 'MS_backplate' }] });
        if (name === 'ae_render_frame') {
          await writeFile(args.outPath, 'png-proof');
          return asMcp({ ok: true, writtenTo: args.outPath, analysis: { coverage: 0.5 } });
        }
        throw new Error('Unexpected AE tool: ' + name);
      },
      async close() {}
    });
    const connect = async () => makeConnection();
    const approvalStore = createApprovalStore();
    const preview = await previewAfterEffectsScene({ project, sceneId: 'scene-1', backupPath, connect, approvalStore });
    assert.equal(preview.host, 'afterEffects');
    assert.equal(calls.some(x => x.name === 'ae_do'), false);
    const receiptDir = path.join(dir, 'ae-receipts');
    const applied = await applyAfterEffectsScene({ approvalId: preview.approvalId, approved: true, connect, approvalStore, receiptDir });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.verified, true);
    assert.equal(applied.steps.filter(x => x.operation).length, preview.plan.operations.length);
    assert.equal(applied.frameProof.bytes, 9);
    await access(backupPath);
    await access(applied.receiptPath);
    const receipt = JSON.parse(await readFile(applied.receiptPath, 'utf8'));
    assert.equal(receipt.host, 'afterEffects');
    assert.equal(typeof receipt.approvalIdHash, 'string');
    assert.equal('approvalId' in receipt, false);
    assert.equal(calls.some(x => x.name === 'ae_do'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Premiere workflow imports verified renders into a new guarded sequence and saves it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-pr-flow-'));
  try {
    const projectFile = path.join(dir, 'test.prproj');
    const backupPath = path.join(dir, 'test-backup.prproj');
    const renderA = path.join(dir, 'scene-a.mp4');
    const renderB = path.join(dir, 'scene-b.mp4');
    const presetFile = path.join(dir, 'default.epr');
    await writeFile(projectFile, 'saved-premiere-project');
    await writeFile(renderA, 'render-a');
    await writeFile(renderB, 'render-b');
    await writeFile(presetFile, '<Preset/>');
    const calls = [];
    let structureCalls = 0;
    const makeConnection = () => ({
      async listTools() { return { tools: prToolNames.map(name => ({ name })) }; },
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'verify_premiere_connection') return asMcp({ success: true, data: { overall: 'ready', backend: 'cep' } });
        if (name === 'get_project_info') return asMcp({ success: true, data: { name: 'Test Project', path: projectFile, activeSequence: null } });
        if (name === 'save_project') return asMcp({ success: true, data: { verified: true, saved: true } });
        if (name === 'import_media') {
          await access(backupPath);
          return asMcp({ success: true, data: { verified: true, items: [{ nodeId: 'item-1' },{ nodeId: 'item-2' }] } });
        }
        if (name === 'create_sequence_from_clips') return asMcp({ success: true, data: { verified: true, id: 'sequence-1', name: args.name, clipCount: 3, requestedClipCount: 2 } });
        if (name === 'get_active_sequence') return asMcp({ success: true, data: { id: 'sequence-1', name: 'Test Assembly' } });
        if (name === 'get_sequence_structure') {
          structureCalls += 1;
          if (structureCalls === 1) return asMcp({ success: true, data: { pagination: { nextOffset: 1 }, sequenceId: 'sequence-1', videoTracks: [{ clips: [{ nodeId: 'item-1' }] }], audioTracks: [] } });
          return asMcp({ success: true, data: { pagination: { nextOffset: null }, sequenceId: 'sequence-1', videoTracks: [{ clips: [{ nodeId: 'item-2' }] }], audioTracks: [] } });
        }
        if (name === 'export_sequence') return asMcp({ success: true, data: { verified: true, output_path: args.output_path } });
        if (name === 'verify_delivery_file') return asMcp({ success: true, data: { verified: true, checksum: 'a'.repeat(64), size: 42 } });
        throw new Error('Unexpected Premiere tool: ' + name);
      },
      async close() {}
    });
    const connect = async () => makeConnection();
    const approvalStore = createApprovalStore();
    const preview = await previewPremiereAssembly({
      renderedScenePaths: [renderA, renderB], backupPath, sequenceName: 'Test Assembly', backend: 'cep', exportPath: path.join(dir, 'final.mp4'), presetPath: presetFile, connect, approvalStore
    });
    assert.equal(preview.mutationScope, 'new-sequence-only');
    const receiptDir = path.join(dir, 'premiere-receipts');
    const applied = await applyPremiereAssembly({ approvalId: preview.approvalId, approved: true, connect, approvalStore, receiptDir });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.verified, true);
    assert.equal(applied.sequence.id, 'sequence-1');
    assert.equal(applied.export.verified, true);
    assert.equal(applied.export.output_path, path.join(dir, 'final.mp4'));
    assert.equal(applied.delivery.verified, true);
    assert.equal(structureCalls, 2);
    await access(backupPath);
    await access(applied.receiptPath);
    const receipt = JSON.parse(await readFile(applied.receiptPath, 'utf8'));
    assert.equal(receipt.host, 'premiere');
    assert.equal(receipt.sequenceName, 'Test Assembly');
    const importCall = calls.find(x => x.name === 'import_media');
    assert.equal(importCall.args.expected_project_path, projectFile);
    const sequenceCall = calls.find(x => x.name === 'create_sequence_from_clips');
    assert.equal(sequenceCall.args.expected_project_path, projectFile);
    const structureCall = calls.find(x => x.name === 'get_sequence_structure');
    assert.equal(structureCall.args.sequence_id, 'sequence-1');
    assert.equal(structureCall.args.clip_offset, 0);
    const exportCall = calls.find(x => x.name === 'export_sequence');
    assert.equal(exportCall.args.expected_project_path, projectFile);
    assert.equal(exportCall.args.preset_path, presetFile);
    const deliveryCall = calls.find(x => x.name === 'verify_delivery_file');
    assert.equal(deliveryCall.args.checksum_algorithm, 'sha256');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Adobe host mutations are serialized per host', async () => {
  const order = [];
  const releaseFirst = await acquireHostMutationLock('afterEffects');
  order.push('first-acquired');
  let secondAcquired = false;
  const secondPromise = acquireHostMutationLock('afterEffects').then(release => {
    secondAcquired = true;
    order.push('second-acquired');
    return release;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondAcquired, false);
  releaseFirst();
  const releaseSecond = await secondPromise;
  assert.equal(secondAcquired, true);
  releaseSecond();
  assert.deepEqual(order, ['first-acquired', 'second-acquired']);
});

test('different Adobe hosts use independent mutation locks', async () => {
  const releaseAE = await acquireHostMutationLock('afterEffects');
  const releasePremiere = await acquireHostMutationLock('premiere');
  releasePremiere();
  releaseAE();
});

test('receipt directory uses per-user state storage paths', () => {
  assert.equal(
    defaultAdobeReceiptDirectory({ platform: 'win32', home: 'C:\\Users\\Tester', env: { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' } }),
    'C:\\Users\\Tester\\AppData\\Local\\motion-studio\\runs'
  );
  assert.equal(
    defaultAdobeReceiptDirectory({ platform: 'darwin', home: '/Users/test', env: {} }),
    '/Users/test/.local/state/motion-studio/runs'
  );
});


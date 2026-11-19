import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveTemplate, getTemplate, listTemplates, registerTemplate, retireTemplate, rollbackTemplate } from './index.mjs';

const TEMPLATE_BODY = { brand: { colors: { background: '#10243a' } }, lowerThird: { sizePx: 42 } };

function fixture({ version = '1.0.0', compatibility = null, approved = false } = {}) {
  return { name: 'corporate-lower-third', version, compatibility, template: TEMPLATE_BODY };
}

test('registration without approval stores a draft; production use is refused', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    const result = await registerTemplate({ registryPath, template: fixture(), author: 'designer' });
    assert.equal(result.ok, true);
    assert.equal(result.entry.status, 'draft');
    const read = await getTemplate({ registryPath, name: 'corporate-lower-third', runningVersion: '1.0.0' });
    assert.equal(read.found, true);
    assert.equal(read.usableInProduction, false);
    assert.match(read.reason, /not approved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('approval makes the template production-usable and the actor is recorded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-approve-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    await registerTemplate({ registryPath, template: fixture(), author: 'designer' });
    const approval = await approveTemplate({ registryPath, name: 'corporate-lower-third', actor: 'producer' });
    assert.equal(approval.ok, true);
    const read = await getTemplate({ registryPath, name: 'corporate-lower-third', runningVersion: '1.0.0' });
    assert.equal(read.usableInProduction, true);
    const onDisk = JSON.parse(await readFile(registryPath, 'utf8'));
    assert.equal(onDisk.templates['corporate-lower-third'].approvedBy, 'producer');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility gates approval and production use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-compat-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    const result = await registerTemplate({ registryPath, template: fixture({ compatibility: { minVersion: '2.0.0' } }), author: 'designer', approved: true, runningVersion: '1.0.0' });
    assert.equal(result.ok, true, 'registration succeeds even when incompatible');
    assert.match(result.compatibilityNote, /stays draft/);
    const read = await getTemplate({ registryPath, name: 'corporate-lower-third', runningVersion: '1.0.0' });
    assert.equal(read.usableInProduction, false);
    const approval = await approveTemplate({ registryPath, name: 'corporate-lower-third', actor: 'producer', runningVersion: '1.0.0' });
    assert.equal(approval.ok, false, 'approval is refused while incompatible');
    assert.match(approval.issues[0].message, /does not cover/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollback restores the previously approved version and refuses when none exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-rollback-'));
  const registryPath = path.join(root, 'templates.json');
  const clock = () => new Date();
  try {
    await registerTemplate({ registryPath, template: fixture({ version: '1.0.0' }), author: 'designer', approved: true, clock });
    await registerTemplate({ registryPath, template: fixture({ version: '2.0.0' }), author: 'designer', approved: true, clock });
    const refused = await rollbackTemplate({ registryPath, name: 'nonexistent', actor: 'producer' });
    assert.equal(refused.ok, false);
    const rolled = await rollbackTemplate({ registryPath, name: 'corporate-lower-third', actor: 'producer', clock });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.entry.version, '1.0.0', 'rollback restores the prior approved version');
    assert.equal(rolled.entry.rolledBackFrom, '2.0.0');
    const read = await getTemplate({ registryPath, name: 'corporate-lower-third', runningVersion: '1.0.0' });
    assert.equal(read.entry.version, '1.0.0');
    assert.equal(read.usableInProduction, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('first-version rollback is refused instead of retiring the only body', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-first-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    await registerTemplate({ registryPath, template: fixture(), author: 'designer', approved: true });
    const refused = await rollbackTemplate({ registryPath, name: 'corporate-lower-third', actor: 'producer' });
    assert.equal(refused.ok, false);
    assert.match(refused.issues[0].message, /no previously approved version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retired templates leave production and listing filters by status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-retire-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    await registerTemplate({ registryPath, template: fixture(), author: 'designer', approved: true });
    await registerTemplate({ registryPath, template: { ...fixture({ version: '1.1.0' }), name: 'end-card' }, author: 'designer', approved: true });
    await retireTemplate({ registryPath, name: 'corporate-lower-third', actor: 'producer' });
    const read = await getTemplate({ registryPath, name: 'corporate-lower-third', runningVersion: '1.0.0' });
    assert.equal(read.usableInProduction, false);
    const approved = await listTemplates({ registryPath, status: 'approved' });
    assert.deepEqual(approved.map(entry => entry.name), ['end-card']);
    const all = await listTemplates({ registryPath });
    assert.equal(all.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed registrations are refused without corrupting the registry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-tpl-malformed-'));
  const registryPath = path.join(root, 'templates.json');
  try {
    const result = await registerTemplate({ registryPath, template: { name: 'bad name!', version: 'not-semver' }, author: 'designer' });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'TEMPLATE_NAME_INVALID'));
    assert.ok(result.issues.some(issue => issue.code === 'TEMPLATE_VERSION_INVALID'));
    const noAuthor = await registerTemplate({ registryPath, template: fixture(), author: '  ' });
    assert.equal(noAuthor.ok, false);
    const listed = await listTemplates({ registryPath });
    assert.deepEqual(listed, [], 'the registry is untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

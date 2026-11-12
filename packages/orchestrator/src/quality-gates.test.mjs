import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQualityGates } from './quality-gates.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoGates = path.join(moduleRoot, 'configs', 'quality-gates.json');

test('a missing config file yields the bounded defaults', async () => {
  const missing = path.join(tmpdir(), 'motion-studio-does-not-exist', 'quality-gates.json');
  const gates = await loadQualityGates(missing);
  assert.deepEqual(gates.repair, { maxCycles: 2, targetedRerender: true, retestRequired: true });
  assert.equal(gates.version, 1);
  assert.equal(gates.sha256, null);
  assert.equal(gates.sourcePath, path.resolve(missing));
});

test('the repository config round-trips with a stable content hash', async () => {
  const gates = await loadQualityGates(repoGates);
  assert.equal(gates.version, 1);
  assert.deepEqual(gates.repair, { maxCycles: 2, targetedRerender: true, retestRequired: true });
  assert.equal(gates.sourcePath, path.resolve(repoGates));
  assert.match(gates.sha256, /^[a-f0-9]{64}$/);
  const again = await loadQualityGates(repoGates);
  assert.equal(again.sha256, gates.sha256);
});

test('maxCycles outside 1..3 is rejected with a throw', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motion-studio-gates-'));
  try {
    for (const maxCycles of [0, 4, -1, 2.5, '2']) {
      const file = path.join(dir, 'gates-' + String(maxCycles).replace(/[^0-9.-]/g, '_') + '.json');
      writeFileSync(file, JSON.stringify({ version: 1, repair: { maxCycles, targetedRerender: true, retestRequired: true } }));
      await assert.rejects(() => loadQualityGates(file), /maxCycles must be an integer between 1 and 3/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-boolean rerender and retest flags are rejected with a throw', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motion-studio-gates-'));
  try {
    const badTargeted = path.join(dir, 'targeted.json');
    writeFileSync(badTargeted, JSON.stringify({ repair: { maxCycles: 2, targetedRerender: 'yes', retestRequired: true } }));
    await assert.rejects(() => loadQualityGates(badTargeted), /targetedRerender must be a boolean/);
    const badRetest = path.join(dir, 'retest.json');
    writeFileSync(badRetest, JSON.stringify({ repair: { maxCycles: 1, targetedRerender: false, retestRequired: 0 } }));
    await assert.rejects(() => loadQualityGates(badRetest), /retestRequired must be a boolean/);
    const malformed = path.join(dir, 'malformed.json');
    writeFileSync(malformed, '{ not json');
    await assert.rejects(() => loadQualityGates(malformed), /not valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('boundary cycle budgets of 1 and 3 are accepted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motion-studio-gates-'));
  try {
    for (const maxCycles of [1, 3]) {
      const file = path.join(dir, 'gates-' + maxCycles + '.json');
      writeFileSync(file, JSON.stringify({ repair: { maxCycles, targetedRerender: false, retestRequired: false } }));
      const gates = await loadQualityGates(file);
      assert.deepEqual(gates.repair, { maxCycles, targetedRerender: false, retestRequired: false });
    }
    const partial = path.join(dir, 'partial.json');
    writeFileSync(partial, JSON.stringify({ repair: { maxCycles: 3 } }));
    const gates = await loadQualityGates(partial);
    assert.deepEqual(gates.repair, { maxCycles: 3, targetedRerender: true, retestRequired: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a directory that cannot be read surfaces the underlying error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motion-studio-gates-'));
  try { await assert.rejects(() => loadQualityGates(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
});

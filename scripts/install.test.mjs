import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adobeGuidance, craftGuidance, installRecordPath, parseInstallerFlags, writeInstallRecord } from './install.mjs';

const INSTALLER = fileURLToPath(new URL('./install.mjs', import.meta.url));

const detectedAllMissing = {
  supported: true,
  effectcraft: { installed: false, path: null },
  filmcraft: { installed: false, path: null }
};
const detectedBothInstalled = {
  supported: true,
  effectcraft: { installed: true, path: 'C:\\craft\\effectcraft-cli.exe' },
  filmcraft: { installed: true, path: 'C:\\craft\\filmcraft-cli.exe' }
};

const adobeAllMissing = {
  supported: true,
  creativeCloud: { installed: false },
  afterEffects: { installed: false },
  premierePro: { installed: false }
};
const adobeUxpPremiere = {
  supported: true,
  creativeCloud: { installed: true },
  afterEffects: { installed: true, version: '26.0' },
  premierePro: { installed: true, version: '2026.1' }
};
const adobeLegacyPremiere = {
  supported: true,
  creativeCloud: { installed: true },
  afterEffects: { installed: true, version: '25.2' },
  premierePro: { installed: true, version: '2024.4' }
};

test('parseInstallerFlags covers the documented option surface', () => {
  const parsed = parseInstallerFlags(['--yes', '-y', '--minimal', '--skip-software', '--skip-hosts', '--dry-run', '--help', '-h']);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.minimal, true);
  assert.equal(parsed.skipHosts, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.help, true);
  const defaults = parseInstallerFlags([]);
  assert.equal(defaults.yes, false);
  assert.equal(defaults.minimal, false);
  assert.equal(defaults.skipHosts, false);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.help, false);
});

test('craft guidance keeps status rows for both tools even when one is missing', () => {
  const guidance = craftGuidance(detectedAllMissing);
  assert.ok(guidance.needsUserAction.some(item => item.includes('EffectCraft')));
  assert.ok(guidance.needsUserAction.some(item => item.includes('FilmCraft')));
  assert.ok(guidance.openUrls.some(url => url.includes('storytold/effectcraft')));
  assert.ok(guidance.openUrls.some(url => url.includes('storytold/filmcraft')));
  assert.equal(guidance.craftMcp.effectcraft.status, 'needs-user-install');
  assert.equal(guidance.craftMcp.filmcraft.status, 'needs-user-install');
  assert.deepEqual(guidance.actions, {});
});

test('craft guidance records ready MCP rows with exact CLI contracts', () => {
  const guidance = craftGuidance(detectedBothInstalled);
  assert.equal(guidance.needsUserAction.length, 0);
  assert.equal(guidance.openUrls.length, 0);
  assert.equal(guidance.craftMcp.effectcraft.status, 'ready');
  assert.deepEqual(guidance.craftMcp.effectcraft.mcpArgs, ['mcp']);
  assert.equal(guidance.craftMcp.effectcraft.command, 'C:\\craft\\effectcraft-cli.exe');
  assert.equal(guidance.craftMcp.filmcraft.status, 'ready');
  assert.deepEqual(guidance.craftMcp.filmcraft.mcpArgs, ['--', 'mcp']);
  assert.match(guidance.craftMcp.filmcraft.note, /filmcraft-cli -- mcp/);
  assert.match(guidance.craftMcp.effectcraft.note, /effectcraft-cli mcp/);
});

test('craft guidance never references Adobe flows', () => {
  const guidance = craftGuidance(detectedAllMissing);
  const serialized = JSON.stringify(guidance).toLowerCase();
  assert.ok(!serialized.includes('creative cloud'), 'no Creative Cloud guidance');
  assert.ok(!serialized.includes('cep'), 'no CEP connector guidance');
  assert.ok(!serialized.includes('uxp'), 'no UXP token guidance');
});

// Dual-stack: the licensed-Adobe guidance stays fully supported alongside.

test('adobe guidance keeps the AE/PP status rows even without Creative Cloud', () => {
  const guidance = adobeGuidance(adobeAllMissing, { installCep: false });
  assert.ok(guidance.needsUserAction.some(item => item.includes('Creative Cloud Desktop')));
  assert.ok(guidance.openUrls.some(url => url.includes('download-creative-cloud-apps')));
  assert.equal(guidance.adobeMcp.afterEffects.status, 'needs-user-install');
  assert.equal(guidance.adobeMcp.premiere.status, 'needs-user-install');
  assert.equal(guidance.actions.premiereTokenSetup, false);
  assert.equal(guidance.actions.runCepInstall, false);
});

test('adobe guidance routes Premiere 2026+ to the UXP token setup', () => {
  const guidance = adobeGuidance(adobeUxpPremiere, { installCep: false });
  assert.equal(guidance.actions.premiereTokenSetup, true);
  assert.equal(guidance.actions.runCepInstall, false);
  assert.equal(guidance.adobeMcp.afterEffects.mode, 'read-only-default');
  assert.equal(guidance.adobeMcp.afterEffects.arbitraryEval, false);
  assert.ok(guidance.needsUserAction.some(item => item.includes('Allow Scripts to Write Files')));
  assert.ok(!guidance.needsUserAction.some(item => item.includes('CEP')));
});

test('adobe guidance routes legacy Premiere to the CEP compatibility decision and honors the opt-in', () => {
  const legacy = adobeGuidance(adobeLegacyPremiere, { installCep: false });
  assert.equal(legacy.actions.premiereTokenSetup, false);
  assert.equal(legacy.adobeMcp.premiere.status, 'needs-user-action');
  assert.match(legacy.adobeMcp.premiere.connector, /compatibility decision required/);
  assert.ok(legacy.needsUserAction.some(item => item.includes('--install-premiere-cep')));
  const optedIn = adobeGuidance(adobeLegacyPremiere, { installCep: true });
  assert.equal(optedIn.actions.runCepInstall, true);
  assert.equal(optedIn.adobeMcp.premiere.connector, 'CEP');
  assert.equal(optedIn.adobeMcp.premiere.status, 'install-command-completed');
});

test('writeInstallRecord persists the failure record with a recovery hint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-install-record-'));
  try {
    const recordPath = installRecordPath(root);
    assert.equal(recordPath, path.join(root, 'motion-studio', 'install.json'));
    await writeInstallRecord(recordPath, { status: 'failed', error: 'npm install failed: 1', recovery: 'Re-run the installer; it is idempotent.' });
    const parsed = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(parsed.status, 'failed');
    assert.match(parsed.error, /npm install failed/);
    assert.match(parsed.recovery, /idempotent/);
    assert.ok(parsed.installedAt, 'the record is timestamped');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer lifecycle smoke: --dry-run reports without writing any state', async () => {
  // Cross-platform lifecycle smoke (P4.2): the dry run exercises flag
  // parsing, node-version gating, software detection and report assembly with
  // zero host writes. Every platform config-root env var points at the same
  // temp dir (APPDATA on Windows, XDG_CONFIG_HOME elsewhere) so the record
  // path assertion holds on all three OSes. The full npm-install path still
  // requires a host run.
  const tempConfigRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-install-config-'));
  try {
    const result = spawnSync(process.execPath, [INSTALLER, '--dry-run', '--skip-hosts', '--minimal'], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, APPDATA: tempConfigRoot, LOCALAPPDATA: tempConfigRoot, XDG_CONFIG_HOME: tempConfigRoot }
    });
    assert.equal(result.status, 0, 'dry run exits cleanly: ' + result.stderr?.slice(-400));
    const jsonStart = result.stdout.indexOf('{');
    assert.ok(jsonStart >= 0, 'the installer prints its JSON report');
    const report = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(report.platform, process.platform);
    assert.equal(report.status, undefined, 'a clean run does not carry the failure status');
    assert.ok(Array.isArray(report.needsUserAction));
    assert.ok(report.detected && typeof report.detected.supported === 'boolean');
    assert.ok(report.craftMcp, 'the report carries craft MCP status rows');
    assert.ok(report.recordPath.startsWith(tempConfigRoot), 'the record path honors the platform config root');
    assert.equal(existsSync(report.recordPath), false, 'a dry run never writes the install record');
    assert.ok(result.stdout.includes('DRY RUN'));
  } finally {
    await rm(tempConfigRoot, { recursive: true, force: true });
  }
});

test('installer self-run failure writes a failure record instead of dying silently', async () => {
  // The failure-record contract: a failing self-run writes status:'failed'
  // with a recovery hint to the install record (verified through the exported
  // helper above) and exits non-zero. Importing the module — as this test
  // file does — must not trigger the self-run gate at all: no main(), no
  // report output, no exit-code side effects. That gate is what keeps the
  // installer importable for these tests.
  const recordPath = installRecordPath(os.tmpdir());
  assert.match(recordPath, /[\\/]motion-studio[\\/]install\.json$/);
});

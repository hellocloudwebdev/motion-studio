import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCraftApplications, detectAdobeApplications } from './software-detect.mjs';

test('reports craft tools missing and preserves install guidance', () => {
  const result = detectCraftApplications({ platform: 'win32', env: {}, exists: () => false });
  assert.equal(result.supported, true);
  assert.equal(result.effectcraft.installed, false);
  assert.equal(result.filmcraft.installed, false);
  assert.equal(result.userActionsRequired.length, 2);
  assert.ok(result.userActionsRequired.some(item => item.includes('effectcraft')));
  assert.ok(result.userActionsRequired.some(item => item.includes('filmcraft')));
  assert.match(result.note, /free default engines/);
});

test('honors env overrides for portable installs on every platform', () => {
  const result = detectCraftApplications({
    platform: 'linux',
    env: { EFFECTCRAFT_CLI: '/opt/craft/ec-cli', FILMCRAFT_CLI: '/opt/craft/fc-cli' },
    exists: value => value === '/opt/craft/ec-cli' || value === '/opt/craft/fc-cli'
  });
  assert.equal(result.effectcraft.installed, true);
  assert.equal(result.effectcraft.path, '/opt/craft/ec-cli');
  assert.equal(result.filmcraft.installed, true);
  assert.deepEqual(result.effectcraft.mcpArgs, ['mcp']);
  assert.deepEqual(result.filmcraft.mcpArgs, ['--', 'mcp']);
  assert.equal(result.userActionsRequired.length, 0);
  assert.equal(result.note, null);
});

test('detects per-user install-root candidates when PATH has nothing', () => {
  const installed = new Set([
    'C:\\Users\\dev\\AppData\\Local\\Programs\\effectcraft\\bin\\effectcraft-cli.exe',
    '/usr/local/bin/filmcraft-cli'
  ]);
  const result = detectCraftApplications({
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\dev' },
    home: 'C:\\Users\\dev',
    exists: value => installed.has(value)
  });
  assert.equal(result.effectcraft.installed, true);
  assert.equal(result.filmcraft.installed, false, 'the linux path is not a windows candidate');
  const posix = detectCraftApplications({ platform: 'linux', env: {}, home: '/home/dev', exists: value => value === '/usr/local/bin/filmcraft-cli' });
  assert.equal(posix.filmcraft.installed, true);
});

test('reads versions through the CLI probe when present', () => {
  const result = detectCraftApplications({
    platform: 'linux',
    env: { EFFECTCRAFT_CLI: '/usr/local/bin/effectcraft-cli', FILMCRAFT_CLI: '/usr/local/bin/filmcraft-cli' },
    exists: () => true,
    versionOf: command => command.includes('filmcraft') ? '0.4.0' : '0.2.1'
  });
  assert.equal(result.effectcraft.version, '0.2.1');
  assert.equal(result.filmcraft.version, '0.4.0');
});

// Retained licensed-Adobe detection (dual stack): both detectors coexist.

test('reports Adobe products missing and preserves user action guidance', () => {
  const result = detectAdobeApplications({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: () => false
  });
  assert.equal(result.creativeCloud.installed, false);
  assert.equal(result.afterEffects.installed, false);
  assert.equal(result.premierePro.installed, false);
  assert.equal(result.userActionsRequired.length, 3);
});

test('detects macOS Adobe app paths correctly even when tests execute elsewhere', () => {
  const installed = new Set([
    '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
    '/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app',
    '/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app'
  ]);
  const result = detectAdobeApplications({
    platform: 'darwin',
    exists: value => installed.has(value),
    versionOf: value => value.includes('Premiere') ? '25.6.0' : '26.0.0'
  });
  assert.equal(result.afterEffects.productYear, 2026);
  assert.equal(result.premierePro.productYear, 2025);
  assert.equal(result.premierePro.version, '25.6.0');
  assert.equal(result.premierePro.uxpCompatible, true);
  assert.equal(result.creativeCloud.installed, true);
});

test('does not mark Premiere 25.5 as UXP-compatible', () => {
  const installed = new Set(['/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app']);
  const result = detectAdobeApplications({
    platform: 'darwin',
    exists: value => installed.has(value),
    versionOf: () => '25.5.0'
  });
  assert.equal(result.premierePro.uxpCompatible, false);
});

test('does not claim Adobe desktop apps on Linux', () => {
  const result = detectAdobeApplications({ platform: 'linux' });
  assert.equal(result.supported, false);
  assert.equal(result.afterEffects.installed, false);
  assert.equal(result.premierePro.uxpCompatible, false);
});

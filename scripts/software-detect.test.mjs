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
  assert.match(result.note, /open source/);
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

test('retired Adobe detection fails loudly instead of misdetecting', () => {
  assert.throws(() => detectAdobeApplications(), /retired/);
});

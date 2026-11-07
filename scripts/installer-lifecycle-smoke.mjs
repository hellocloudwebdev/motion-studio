import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-installer-smoke-'));
const home = path.join(temp, 'home');
const config = path.join(temp, 'config');
const appRoot = process.platform === 'win32'
  ? path.join(home, 'AppData', 'Local', 'motion-studio', 'app')
  : path.join(home, '.local', 'share', 'motion-studio', 'app');
const recordPath = path.join(config, 'motion-studio', 'install.json');
const cursorConfig = path.join(home, '.cursor', 'mcp.json');
const codexAdapter = path.join(config, 'motion-studio', 'adapters', 'codex.mcp.json');
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: config,
  HYPERFRAMES_NO_TELEMETRY: '1',
  HYPERFRAMES_NO_UPDATE_CHECK: '1',
  npm_config_update_notifier: 'false'
};
if (process.platform === 'win32') {
  env.USERPROFILE = home;
  env.APPDATA = config;
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
}
const run = (args, label) => {
  console.log('[installer-smoke] ' + label);
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(label + ' failed: ' + (result.error?.message || result.status));
};

try {
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await mkdir(path.dirname(codexAdapter), { recursive: true });
  await writeFile(path.join(home, 'user-data.txt'), 'preserve this file\n');
  await writeFile(cursorConfig, JSON.stringify({ mcpServers: { 'user-server': { command: 'keep-user-server', args: [] } } }));
  await writeFile(codexAdapter, JSON.stringify({ mcpServers: { 'user-adapter': { command: 'keep-user-adapter', args: [] } } }));
  run([path.join(root, 'scripts/install.mjs'), '--minimal'], 'clean install');
  await access(path.join(appRoot, 'package.json'));
  await access(recordPath);
  const cursorAfterInstall = JSON.parse(await readFile(cursorConfig, 'utf8'));
  assert.ok(cursorAfterInstall.mcpServers['motion-studio']);
  assert.ok(cursorAfterInstall.mcpServers['user-server']);
  run([path.join(root, 'scripts/install.mjs'), '--minimal'], 'repeat install / in-place upgrade');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(path.resolve(record.installPath), path.resolve(appRoot));
  run([path.join(root, 'scripts/uninstall.mjs')], 'uninstall dry run');
  await access(appRoot);
  run([path.join(root, 'scripts/uninstall.mjs'), '--yes'], 'uninstall');
  await assert.rejects(access(appRoot));
  await assert.rejects(access(recordPath));
  await access(path.join(home, 'user-data.txt'));
  const cursorAfterUninstall = JSON.parse(await readFile(cursorConfig, 'utf8'));
  assert.deepEqual(Object.keys(cursorAfterUninstall.mcpServers), ['user-server']);
  const codexAfterUninstall = JSON.parse(await readFile(codexAdapter, 'utf8'));
  assert.deepEqual(Object.keys(codexAfterUninstall.mcpServers), ['user-adapter']);
  console.log('[installer-smoke] PASS: clean install, repeat install, host config merge, dry-run and uninstall; user config preserved.');
} finally {
  await rm(temp, { recursive: true, force: true });
}

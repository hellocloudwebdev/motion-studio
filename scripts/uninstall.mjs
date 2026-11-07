#!/usr/bin/env node
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const platform = process.platform;
const configRoot = platform === 'win32'
  ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
const dataRoot = platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
  : path.join(home, '.local', 'share');
const appRoot = path.join(dataRoot, 'motion-studio', 'app');
const recordPath = path.join(configRoot, 'motion-studio', 'install.json');
const confirm = process.argv.includes('--yes');
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const within = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

if (!(await exists(recordPath))) {
  console.log('Motion Studio install record not found; nothing to uninstall.');
  process.exit(0);
}
const record = JSON.parse(await readFile(recordPath, 'utf8'));
if (path.resolve(record.installPath || '') !== path.resolve(appRoot)) {
  throw new Error('Install record path does not match the expected Motion Studio install location. Refusing to remove files.');
}
if (!(await exists(appRoot))) {
  console.log('Install record exists but the application directory is already absent.');
}
const agentFiles = (await exists(path.join(appRoot, 'agents')))
  ? (await readdir(path.join(appRoot, 'agents'))).filter(name => name.endsWith('.md') && name !== 'README.md')
  : [];
const staged = record.stagedSkills || {};
const skillTargets = [
  path.join(home, '.claude', 'skills'),
  path.join(home, '.agents', 'skills'),
  path.join(home, '.codex', 'skills'),
  path.join(home, '.cursor', 'skills')
];
const adapterHosts = ['claude', 'codex', 'zcode', 'deepseek'];
const adapterConfigs = adapterHosts.map(host => path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json'));
const cursorConfig = path.join(home, '.cursor', 'mcp.json');
const plan = [
  appRoot,
  recordPath,
  ...adapterConfigs,
  ...skillTargets.flatMap((target, index) => (staged[['claude','codex','codexLegacy','cursor'][index]] || []).map(name => path.join(target, name))),
  ...agentFiles.map(name => path.join(home, '.claude', 'agents', 'motion-studio-' + name))
];
for (const target of plan) {
  if (!within(home, target)) throw new Error('Refusing to operate outside the user home directory: ' + target);
}
if (!confirm) {
  console.log('Dry run. The following Motion Studio-owned paths are candidates for removal:');
  for (const target of plan) if (await exists(target)) console.log(' - ' + target);
  console.log('Run with --yes to remove these paths. Existing user MCP configuration and secret files are preserved.');
  process.exit(0);
}

const removed = [];
if (await exists(cursorConfig)) {
  try {
    const config = JSON.parse(await readFile(cursorConfig, 'utf8'));
    const servers = config.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      let changed = false;
      for (const [name, server] of Object.entries(servers)) {
        const args = Array.isArray(server?.args) ? server.args : [];
        const owned = args.some(arg => typeof arg === 'string' && within(appRoot, arg));
        if (owned) { delete servers[name]; changed = true; }
      }
      if (changed) await writeFile(cursorConfig, JSON.stringify(config, null, 2) + '\n');
    }
  } catch (error) {
    console.warn('Could not safely edit Cursor MCP config; it was preserved: ' + error.message);
  }
}
for (const file of adapterConfigs) {
  if (!(await exists(file))) continue;
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (config.motionStudioManaged === true) { await rm(file); removed.push(file); }
  } catch {
    console.warn('Preserved unrecognized adapter config: ' + file);
  }
}
for (let index = 0; index < skillTargets.length; index++) {
  const names = staged[['claude','codex','codexLegacy','cursor'][index]] || [];
  for (const name of names) {
    const target = path.join(skillTargets[index], name);
    if (within(skillTargets[index], target) && await exists(target)) { await rm(target, { recursive: true, force: true }); removed.push(target); }
  }
}
for (const name of agentFiles) {
  const target = path.join(home, '.claude', 'agents', 'motion-studio-' + name);
  if (await exists(target)) { await rm(target); removed.push(target); }
}
if (await exists(appRoot)) { await rm(appRoot, { recursive: true, force: true }); removed.push(appRoot); }
if (await exists(recordPath)) { await rm(recordPath); removed.push(recordPath); }
console.log(JSON.stringify({
  uninstalled: true,
  removed,
  preserved: [
    'Cursor MCP entries not pointing into the Motion Studio install directory',
    'unmarked adapter configuration files',
    'Premiere UXP token and other secret files',
    'Claude Code/Codex CLI registrations (remove those explicitly with each host CLI if previously registered)'
  ],
  note: 'Adobe applications and Creative Cloud installations are not removed.'
}, null, 2));

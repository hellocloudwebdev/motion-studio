#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCraftApplications } from './software-detect.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Pure flag parsing (P4.2): exported so the installer lifecycle tests can pin
// the option surface without spawning the installer.
export function parseInstallerFlags(argv) {
  const flags = new Set(argv);
  return {
    flags,
    yes: flags.has('--yes') || flags.has('-y'),
    minimal: flags.has('--minimal') || flags.has('--skip-software'),
    skipHosts: flags.has('--skip-hosts'),
    dryRun: flags.has('--dry-run'),
    help: flags.has('--help') || flags.has('-h')
  };
}

// Pure craft-guidance decision (P4.2, architecture pivot 2026-11-14): the
// exact messages and MCP status rows the installer produces for every
// detected-software shape. FilmCraft and EffectCraft are free open-source
// tools, so unlike the retired Adobe flow there is no account, CEP connector
// or token setup — just binary presence and MCP registration.
export function craftGuidance(detected) {
  const needsUserAction = [];
  const openUrls = [];
  const craftMcp = {};
  if (!detected?.effectcraft?.installed) {
    needsUserAction.push('Install EffectCraft (https://github.com/storytold/effectcraft) — the specialist motion-graphics/VFX engine. It is free and open source; installers ship on the releases page and getartcraft.com.');
    openUrls.push('https://github.com/storytold/effectcraft/releases');
  }
  if (!detected?.filmcraft?.installed) {
    needsUserAction.push('Install FilmCraft (https://github.com/storytold/filmcraft) — the editorial assembly and export engine. It is free and open source; installers ship on the releases page and getartcraft.com.');
    openUrls.push('https://github.com/storytold/filmcraft/releases');
  }
  craftMcp.effectcraft = detected?.effectcraft?.installed
    ? { command: detected.effectcraft.path, mcpArgs: ['mcp'], status: 'ready', note: 'Alpha tool: drive it headless via `effectcraft-cli mcp`.' }
    : { command: null, status: 'needs-user-install' };
  craftMcp.filmcraft = detected?.filmcraft?.installed
    ? { command: detected.filmcraft.path, mcpArgs: ['--', 'mcp'], status: 'ready', note: 'Alpha tool: drive it headless via `filmcraft-cli -- mcp`.' }
    : { command: null, status: 'needs-user-install' };
  return { needsUserAction, openUrls, craftMcp, actions: {} };
}

// Failure tracking (P4.2/P4.3): the install record is written even when the
// installer fails, with a recovery hint, so a failed run is never silent.
export function installRecordPath(configRoot) {
  return path.join(configRoot, 'motion-studio', 'install.json');
}
export async function writeInstallRecord(recordPath, report) {
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify({ ...report, installedAt: new Date().toISOString() }, null, 2) + '\n');
}

const argv = process.argv.slice(2);
const { flags, yes, minimal, skipHosts, dryRun, help } = parseInstallerFlags(argv);
const platform = process.platform;
const home = os.homedir();
const configRoot = platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
const dataRoot = platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')) : path.join(home, '.local', 'share');
const appRoot = path.join(dataRoot, 'motion-studio', 'app');
const version = (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim();
const report = {
  version, platform, architecture: os.arch(), node: process.version,
  installed: [], detected: {}, stagedSkills: {}, hostIntegrations: [], craftMcp: {},
  needsUserAction: [], warnings: []
};

function commandExists(command) {
  const checker = platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(checker, [command], { stdio: 'ignore', shell: false }).status === 0;
}
function run(command, args, label, optional = false, cwd = sourceRoot) {
  console.log('[Motion Studio] ' + label);
  if (dryRun) return { ok: true, status: 0 };
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, cwd, env: process.env });

  if (result.error || result.status !== 0) {
    const message = label + ' failed: ' + (result.error?.message || result.status);
    if (optional) { report.warnings.push(message); return { ok: false, status: result.status }; }
    throw new Error(message);
  }
  return { ok: true, status: 0 };
}
function runNpm(args, label, cwd = appRoot, optional = false) {
  if (platform !== 'win32') return run('npm', args, label, optional, cwd);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return run(process.execPath, [npmCli, ...args], label, optional, cwd);
}
function runHostCli(command, args, label) {
  if (platform !== 'win32') return run(command, args, label, true, appRoot);
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  const commandLine = [command, ...args].map(quote).join(' ');
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], label, true, appRoot);
}
function openUrl(url) {
  if (dryRun) return;
  if (platform === 'win32') spawnSync('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', shell: false });
  else if (platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore', shell: false });
  else if (commandExists('xdg-open')) spawnSync('xdg-open', [url], { stdio: 'ignore', shell: false });
}
function manager() {
  if (platform === 'win32' && commandExists('winget')) return 'winget';
  if (platform === 'darwin' && commandExists('brew')) return 'brew';
  if (platform === 'linux') for (const name of ['apt-get', 'dnf', 'pacman', 'zypper']) if (commandExists(name)) return name;
  return null;
}
function installSystem(name) {
  if (commandExists(name)) { report.installed.push(name + ':already-present'); return; }
  const pm = manager();
  let cmd, args;
  if (pm === 'winget') { cmd = 'winget'; args = ['install', '--exact', '--id', name === 'ffmpeg' ? 'Gyan.FFmpeg' : 'BlenderFoundation.Blender', '--accept-package-agreements', '--accept-source-agreements']; }
  else if (pm === 'brew') { cmd = 'brew'; args = name === 'ffmpeg' ? ['install', 'ffmpeg'] : ['install', '--cask', 'blender']; }
  else if (pm === 'apt-get') { cmd = 'sudo'; args = ['apt-get', 'install', '-y', name]; }
  else if (pm === 'dnf') { cmd = 'sudo'; args = ['dnf', 'install', '-y', name]; }
  else if (pm === 'pacman') { cmd = 'sudo'; args = ['pacman', '-S', '--needed', '--noconfirm', name]; }
  else if (pm === 'zypper') { cmd = 'sudo'; args = ['zypper', '--non-interactive', 'install', name]; }
  else { report.warnings.push('No supported package manager found for ' + name + '; install it manually.'); return; }
  const result = run(cmd, args, 'Installing ' + name, true);
  if (result.ok) report.installed.push(name);
}
async function copySkills(source, target) {
  const names = [];
  let entries = [];
  try { entries = await readdir(source, { withFileTypes: true }); } catch { return names; }
  for (const entry of entries.filter(item => item.isDirectory())) {
    const from = path.join(source, entry.name);
    try { await access(path.join(from, 'SKILL.md')); } catch { continue; }
    const name = 'motion-studio-' + entry.name;
    if (!dryRun) { await mkdir(target, { recursive: true }); await cp(from, path.join(target, name), { recursive: true, force: true }); }
    names.push(name);
  }
  return names;
}
function packageEntry(name) {
  try { return require.resolve(name); }
  catch (error) { throw new Error('Required MCP package not found after npm install: ' + name + '. ' + error.message); }
}
function mcpServers() {
  return {
    'motion-studio': { command: process.execPath, args: [path.join(appRoot, 'scripts', 'mcp-launcher.mjs')] },
    'effectcraft': { command: process.execPath, args: [path.join(appRoot, 'scripts', 'craft-mcp-launcher.mjs'), 'effectcraft'] },
    'filmcraft': { command: process.execPath, args: [path.join(appRoot, 'scripts', 'craft-mcp-launcher.mjs'), 'filmcraft'] }
  };
}
function uniqueKey(map, base, desired) {
  if (!map[base] || JSON.stringify(map[base]) === JSON.stringify(desired)) return base;
  let i = 1;
  while (map[base + '-managed-' + i] && JSON.stringify(map[base + '-managed-' + i]) !== JSON.stringify(desired)) i += 1;
  return base + '-managed-' + i;
}
async function stageHosts() {
  const skills = path.join(appRoot, 'skills');
  const targets = {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.agents', 'skills'),
    codexLegacy: path.join(home, '.codex', 'skills'),
    cursor: path.join(home, '.cursor', 'skills')
  };
  for (const [name, target] of Object.entries(targets)) report.stagedSkills[name] = await copySkills(skills, target);

  try {
    const agentFiles = (await readdir(path.join(appRoot, 'agents'))).filter(file => file.endsWith('.md') && file !== 'README.md');
    const target = path.join(home, '.claude', 'agents');
    if (!dryRun) {
      await mkdir(target, { recursive: true });
      for (const file of agentFiles) await cp(path.join(appRoot, 'agents', file), path.join(target, 'motion-studio-' + file), { force: true });
    }
    report.hostIntegrations.push('claude-agent-files');
  } catch (error) { report.warnings.push('Could not stage Claude specialist agents: ' + error.message); }

  const servers = mcpServers();
  const cursorFile = path.join(home, '.cursor', 'mcp.json');
  try {
    let config = {};
    try { config = JSON.parse(await readFile(cursorFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {};
    const registered = [];
    for (const [name, server] of Object.entries(servers)) {
      const key = uniqueKey(config.mcpServers, name, server);
      if (!config.mcpServers[key]) config.mcpServers[key] = server;
      registered.push(key);
    }
    if (!dryRun) { await mkdir(path.dirname(cursorFile), { recursive: true }); await writeFile(cursorFile, JSON.stringify(config, null, 2) + '\n'); }
    report.hostIntegrations.push('cursor-mcp:' + registered.join(','));
  } catch (error) { report.warnings.push('Cursor MCP settings preserved; manual setup needed: ' + error.message); }

  for (const host of ['claude', 'codex', 'zcode', 'deepseek']) {
    const file = path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json');
    if (!dryRun) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n'); }
    report.hostIntegrations.push(host + '-mcp-config');
  }

  if (commandExists('claude')) {
    for (const [name, server] of Object.entries(servers)) {
      runHostCli('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', name, '--', server.command, ...server.args], 'Registering Claude Code ' + name);
    }
  }
  if (commandExists('codex')) {
    for (const [name, server] of Object.entries(servers)) {
      runHostCli('codex', ['mcp', 'add', name, '--', server.command, ...server.args], 'Registering Codex ' + name);
    }
  }
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required for the craft-tool MCP integration.');
  if (flags.has('--help') || flags.has('-h')) {
    console.log('Motion Studio installer options: --yes, --minimal, --skip-software, --skip-hosts, --dry-run');
    return;
  }
  console.log('Motion Studio ' + version + ' installer — ' + platform + '/' + os.arch());
  if (dryRun) console.log('DRY RUN: no changes will be made.');
  if (!dryRun) {
    await mkdir(path.dirname(appRoot), { recursive: true });
    if (path.resolve(sourceRoot) !== path.resolve(appRoot)) {
      await cp(sourceRoot, appRoot, { recursive: true, force: true, filter: src => !src.includes(path.sep + '.git' + path.sep) && !src.includes(path.sep + 'node_modules' + path.sep) });
    }
  }
  if (!minimal && yes) { installSystem('ffmpeg'); installSystem('blender'); }
  if (!minimal && yes && flags.has('--install-blender')) installSystem('blender');

  if (!dryRun) {
    runNpm(['install', '--no-audit', '--no-fund'], 'Installing pinned Motion Studio, HyperFrames and Adobe MCP packages', appRoot);
    const appRequire = createRequire(path.join(appRoot, 'package.json'));
    const hyperframesEntry = appRequire.resolve('hyperframes');
    run(process.execPath, [hyperframesEntry, 'browser', 'ensure'], 'Preparing HyperFrames headless browser', true, appRoot);
  }

  report.detected = detectCraftApplications();
  if (!report.detected.supported) report.warnings.push(report.detected.note);
  else {
    const guidance = craftGuidance(report.detected);
    report.needsUserAction.push(...guidance.needsUserAction);
    report.craftMcp = guidance.craftMcp;
    for (const url of guidance.openUrls) openUrl(url);
  }
  if (!skipHosts) await stageHosts();
  else report.warnings.push('Host integrations skipped by --skip-hosts.');

  const recordPath = installRecordPath(configRoot);
  if (!dryRun) {
    await writeInstallRecord(recordPath, { ...report, installPath: appRoot });
  }
  console.log(JSON.stringify({ ...report, installPath: appRoot, recordPath }, null, 2));
}

// Self-run gate + failure tracking (P4.2): the module is importable for tests;
// a real run that fails still writes its install record with a recovery hint,
// so a failed install is never silent and re-runs are idempotent.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    report.status = 'failed';
    report.error = error?.message ?? String(error);
    report.recovery = 'Re-run the installer with the same options; it is idempotent — already-installed components are detected and skipped, and partial state is refreshed.';
    try {
      const recordPath = installRecordPath(configRoot);
      await writeInstallRecord(recordPath, { ...report, installPath: appRoot });
      console.error('Motion Studio install FAILED. Record written to ' + recordPath);
    } catch { console.error('Motion Studio install FAILED and the failure record could not be written.'); }
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}

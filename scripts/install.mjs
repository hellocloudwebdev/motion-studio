#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = new Set(argv);
const yes = flags.has('--yes') || flags.has('-y');
const minimal = flags.has('--minimal') || flags.has('--skip-software');
const skipHosts = flags.has('--skip-hosts');
const dryRun = flags.has('--dry-run');
const platform = process.platform;
const home = os.homedir();
const configRoot = platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
const dataRoot = platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')) : path.join(home, '.local', 'share');
const appRoot = path.join(dataRoot, 'motion-studio', 'app');
const userBin = platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm') : path.join(home, '.local', 'bin');
const version = (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim();
const report = { version, platform, architecture: os.arch(), installed: [], stagedSkills: {}, hostIntegrations: [], warnings: [] };

function commandExists(command) {
  const checker = platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(checker, [command], { stdio: 'ignore', shell: false }).status === 0;
}
function run(command, args, label, optional = false, cwd = sourceRoot) {
  console.log('[Motion Studio] ' + label);
  if (dryRun) return true;
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, cwd, env: process.env });
  if (result.error || result.status !== 0) {
    if (optional) { report.warnings.push(label + ' did not complete: ' + (result.error?.message || result.status)); return false; }
    throw new Error(label + ' failed: ' + (result.error?.message || result.status));
  }
  return true;
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
  if (run(cmd, args, 'Installing ' + name, true)) report.installed.push(name);
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
async function stageHosts() {
  const skills = path.join(appRoot, 'skills');
  const targets = {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.agents', 'skills'),
    codexLegacy: path.join(home, '.codex', 'skills'),
    cursor: path.join(home, '.cursor', 'skills')
  };
  for (const [name, target] of Object.entries(targets)) report.stagedSkills[name] = await copySkills(skills, target);
  const agentsRoot = path.join(appRoot, 'agents');
  const claudeAgents = path.join(home, '.claude', 'agents');
  try {
    const files = (await readdir(agentsRoot)).filter(file => file.endsWith('.md') && file !== 'README.md');
    if (!dryRun) {
      await mkdir(claudeAgents, { recursive: true });
      for (const file of files) await cp(path.join(agentsRoot, file), path.join(claudeAgents, 'motion-studio-' + file), { force: true });
    }
    report.hostIntegrations.push('claude-agent-files');
  } catch {}
  const serverEntry = path.join(appRoot, 'scripts', 'mcp-launcher.mjs');
  const desired = { command: 'node', args: [serverEntry] };
  const cursorFile = path.join(home, '.cursor', 'mcp.json');
  try {
    let config = {};
    try { config = JSON.parse(await readFile(cursorFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {};
    let key = 'motion-studio';
    if (config.mcpServers[key] && JSON.stringify(config.mcpServers[key]) !== JSON.stringify(desired)) key = 'motion-studio-managed';
    if (!config.mcpServers[key]) config.mcpServers[key] = desired;
    if (!dryRun) { await mkdir(path.dirname(cursorFile), { recursive: true }); await writeFile(cursorFile, JSON.stringify(config, null, 2) + '\n'); }
    report.hostIntegrations.push('cursor-mcp:' + key);
  } catch (error) { report.warnings.push('Cursor MCP settings preserved; manual setup needed: ' + error.message); }
  const generic = { mcpServers: { 'motion-studio': desired } };
  for (const host of ['zcode', 'deepseek']) {
    const file = path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json');
    if (!dryRun) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(generic, null, 2) + '\n'); }
    report.hostIntegrations.push(host + '-mcp-config');
  }
  if (commandExists('claude')) {
    run('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'motion-studio', '--', 'node', serverEntry], 'Registering Claude Code MCP', true);
    report.hostIntegrations.push('claude-code-mcp');
  }
  if (commandExists('codex')) {
    run('codex', ['mcp', 'add', 'motion-studio', '--', 'node', serverEntry], 'Registering Codex MCP', true);
    report.hostIntegrations.push('codex-mcp');
  }
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
if (flags.has('--help') || flags.has('-h')) { console.log('Options: --yes, --minimal, --skip-software, --skip-hosts, --dry-run'); process.exit(0); }
console.log('Motion Studio ' + version + ' installer — ' + platform + '/' + os.arch());
if (!dryRun) {
  await mkdir(path.dirname(appRoot), { recursive: true });
  if (path.resolve(sourceRoot) !== path.resolve(appRoot)) {
    await cp(sourceRoot, appRoot, { recursive: true, force: true, filter: src => !src.includes(path.sep + '.git' + path.sep) && !src.includes(path.sep + 'node_modules' + path.sep) });
  }
}
if (!minimal && yes) { installSystem('ffmpeg'); installSystem('blender'); }
if (!dryRun) {
  run('npm', ['install', '--no-audit', '--no-fund'], 'Installing workspace dependencies', false, appRoot);
  run('npm', ['install', '--global', 'hyperframes', '--no-audit', '--no-fund'], 'Installing HyperFrames CLI', true, appRoot);
  if (commandExists('hyperframes')) run('hyperframes', ['browser', 'ensure'], 'Preparing HyperFrames browser', true, appRoot);
}
if (!skipHosts) await stageHosts();
else report.warnings.push('Host integrations skipped by --skip-hosts.');
const recordPath = path.join(configRoot, 'motion-studio', 'install.json');
if (!dryRun) { await mkdir(path.dirname(recordPath), { recursive: true }); await writeFile(recordPath, JSON.stringify({ ...report, installedAt: new Date().toISOString(), installPath: appRoot }, null, 2) + '\n'); }
console.log(JSON.stringify({ ...report, installPath: appRoot, recordPath }, null, 2));

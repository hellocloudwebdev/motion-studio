#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAdobeApplications } from './software-detect.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flags = new Set(argv);
const yes = flags.has('--yes') || flags.has('-y');
const minimal = flags.has('--minimal') || flags.has('--skip-software');
const skipHosts = flags.has('--skip-hosts');
const installCep = flags.has('--install-premiere-cep');
const dryRun = flags.has('--dry-run');
const platform = process.platform;
const home = os.homedir();
const configRoot = platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
const dataRoot = platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')) : path.join(home, '.local', 'share');
const appRoot = path.join(dataRoot, 'motion-studio', 'app');
const version = (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim();
const report = {
  version, platform, architecture: os.arch(), node: process.version,
  installed: [], detected: {}, stagedSkills: {}, hostIntegrations: [], adobeMcp: {},
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
  if (dryRun || process.env.MOTION_STUDIO_NO_OPEN_URL === '1') return;
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
    'aftereffects': { command: process.execPath, args: [path.join(appRoot, 'scripts', 'adobe-mcp-launcher.mjs'), 'aftereffects'] },
    'premiere-pro': { command: process.execPath, args: [path.join(appRoot, 'scripts', 'adobe-mcp-launcher.mjs'), 'premiere'] }
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
    let config = {}, existed = false;
    try { config = JSON.parse(await readFile(file, 'utf8')); existed = true; }
    catch (error) { if (error.code !== 'ENOENT') { report.warnings.push('Preserved unreadable ' + host + ' MCP config: ' + error.message); continue; } }
    if (!config || typeof config !== 'object' || Array.isArray(config)) { report.warnings.push('Preserved invalid ' + host + ' MCP config.'); continue; }
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {};
    const registered = [];
    for (const [name, server] of Object.entries(servers)) {
      const key = uniqueKey(config.mcpServers, name, server);
      if (!config.mcpServers[key]) config.mcpServers[key] = server;
      registered.push(key);
    }
    if (!existed) config.motionStudioManaged = true;
    if (!dryRun) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(config, null, 2) + '\n'); }
    report.hostIntegrations.push(host + '-mcp-config:' + registered.join(','));
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
async function setupPremiereToken() {
  const secretsDir = path.join(configRoot, 'motion-studio', 'secrets');
  const tokenPath = path.join(secretsDir, 'premiere-uxp-token');
  if (!dryRun) {
    await mkdir(secretsDir, { recursive: true });
    let exists = false;
    try { await access(tokenPath); exists = true; } catch {}
    if (!exists) {
      await writeFile(tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
      if (platform !== 'win32') await chmod(tokenPath, 0o600);
    }
  }
  report.adobeMcp.premiereUxpTokenPath = tokenPath;
  report.needsUserAction.push('For Premiere Pro UXP 25.6+, install the pinned v1.28.0 CCX connector in Creative Cloud Desktop and paste the generated token into the UXP panel settings.');
  report.adobeMcp.premiereUxpConnector = 'needs-user-install';
  openUrl('https://github.com/leancoderkavy/premiere-pro-mcp/releases/download/v1.29.0/premiere-pro-mcp-uxp-1.28.0-direct.ccx');
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required for the After Effects MCP integration.');
  if (flags.has('--help') || flags.has('-h')) {
    console.log('Motion Studio installer options: --yes, --minimal, --skip-software, --skip-hosts, --dry-run, --install-premiere-cep');
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
  if (!minimal && yes) installSystem('ffmpeg');
  if (!minimal && flags.has('--install-blender')) installSystem('blender');

  if (!dryRun) {
    runNpm(['install', '--no-audit', '--no-fund', '--workspaces=false'], 'Installing pinned Motion Studio, HyperFrames and Adobe MCP packages', appRoot);
    const hyperframesRoot = path.join(appRoot, 'node_modules', 'hyperframes');
    const hyperframesPackage = JSON.parse(await readFile(path.join(hyperframesRoot, 'package.json'), 'utf8'));
    const hyperframesBin = typeof hyperframesPackage.bin === 'string'
      ? hyperframesPackage.bin
      : (hyperframesPackage.bin?.hyperframes || Object.values(hyperframesPackage.bin || {})[0]);
    if (!hyperframesBin) throw new Error('Installed HyperFrames package does not declare a CLI binary.');
    const hyperframesEntry = path.resolve(hyperframesRoot, hyperframesBin);
    run(process.execPath, [hyperframesEntry, 'browser', 'ensure'], 'Preparing HyperFrames headless browser', true, appRoot);
  }

  report.detected = detectAdobeApplications();
  if (!report.detected.supported) report.warnings.push(report.detected.note);
  else {
    if (!report.detected.creativeCloud.installed) {
      report.needsUserAction.push('Install Adobe Creative Cloud Desktop and sign in with an account that includes After Effects and Premiere Pro.');
      openUrl('https://helpx.adobe.com/download-install/apps/download-install-apps/creative-cloud-apps/download-creative-cloud-apps.html');
    } else {
      if (!report.detected.afterEffects.installed) report.needsUserAction.push('Install After Effects from Creative Cloud Desktop. Motion Studio cannot sign in or activate Adobe products for you.');
      if (!report.detected.premierePro.installed) report.needsUserAction.push('Install Premiere Pro from Creative Cloud Desktop. Motion Studio cannot sign in or activate Adobe products for you.');
      if (!report.detected.afterEffects.installed || !report.detected.premierePro.installed) openUrl('https://creativecloud.adobe.com/apps/download/creative-cloud');
    }
    if (report.detected.afterEffects.installed) {
      report.adobeMcp.afterEffects = { package: '@kumoproductions/mcp-aftereffects@0.3.2', installed: true, mode: 'read-only-default', arbitraryEval: false };
      report.needsUserAction.push('In After Effects, enable Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network, then launch After Effects for MCP control.');
    } else report.adobeMcp.afterEffects = { package: '@kumoproductions/mcp-aftereffects@0.3.2', installed: true, host: 'missing', status: 'needs-user-install' };
    if (report.detected.premierePro.installed) {
      report.adobeMcp.premiere = { package: 'premiere-pro-mcp@1.29.0', hostVersion: report.detected.premierePro.version, uxpCompatible: report.detected.premierePro.uxpCompatible };
      if (report.detected.premierePro.uxpCompatible === true) await setupPremiereToken();
      else if (report.detected.premierePro.uxpCompatible === null) {
        report.needsUserAction.push('Premiere exact version could not be confirmed. CEP compatibility install is available for the 0.4 assembly workflow.');
      }
      if (!installCep) report.needsUserAction.push('Motion Studio 0.4 Premiere assembly requires the CEP compatibility connector. Close Premiere Pro and rerun install.ps1 --install-premiere-cep (or ./install.sh --install-premiere-cep).');
    } else report.adobeMcp.premiere = { package: 'premiere-pro-mcp@1.29.0', host: 'missing', status: 'needs-user-install' };
    if (installCep && report.detected.premierePro.installed) {
      runNpm(['exec', '--', 'premiere-pro-mcp', '--install-cep'], 'Installing upstream Premiere CEP connector', appRoot);
      report.adobeMcp.premiere = { package: 'premiere-pro-mcp@1.29.0', connector: 'CEP', status: 'install-command-completed' };
    }
  }
  if (!skipHosts) await stageHosts();
  else report.warnings.push('Host integrations skipped by --skip-hosts.');

  const recordPath = path.join(configRoot, 'motion-studio', 'install.json');
  if (!dryRun) {
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify({ ...report, installedAt: new Date().toISOString(), installPath: appRoot }, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ...report, installPath: appRoot, recordPath }, null, 2));
}
await main();

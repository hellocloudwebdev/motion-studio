// Roadmap M1.9 — configuration-preserving uninstall. Motion Studio installs
// its app copy, staged skills/agents, per-host adapter configs, Cursor MCP
// keys and host-CLI registrations; everything else on the machine (user
// skills, user MCP keys, craft/Adobe software, generated tokens, system
// media/3D tools, user productions) must survive an uninstall untouched.
// The plan is computed purely from the installer's own record (install.json)
// plus the current filesystem — no shared manifest is assumed; a missing or
// unreadable record fails closed.
import path from 'node:path';
import os from 'node:os';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SERVER_NAMES = ['motion-studio', 'effectcraft', 'filmcraft', 'aftereffects', 'premiere-pro'];
const SKILL_ROOTS = { claude: '.claude/skills', codex: '.agents/skills', codexLegacy: '.codex/skills', cursor: '.cursor/skills' };
const AGENT_ROOT = '.claude/agents';

export async function loadUninstallRecord(recordPath) {
  let text;
  try { text = await readFile(recordPath, 'utf8'); }
  catch (error) { throw new Error('No Motion Studio install record at ' + recordPath + ' — nothing was installed by this installer, so nothing will be removed.'); }
  const record = JSON.parse(text);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('The install record at ' + recordPath + ' is malformed; refusing to uninstall from unknown state.');
  if (!record.installPath) throw new Error('The install record does not name an installPath; refusing to uninstall from unknown state.');
  return record;
}

export function computeUninstallPlan(record, { home, configRoot, removeSecrets = false, removeSystemTools = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !record.installPath) throw new Error('computeUninstallPlan requires the installer record with installPath.');
  if (typeof home !== 'string' || !home || typeof configRoot !== 'string' || !configRoot) throw new Error('computeUninstallPlan requires home and configRoot.');
  const plan = { recordVersion: record.version ?? null, remove: [], preserve: [], warnings: [] };
  const appRoot = path.resolve(record.installPath);
  plan.remove.push({ kind: 'directory', path: appRoot, reason: 'Motion Studio application copy (recorded installPath)' });

  for (const [host, names] of Object.entries(record.stagedSkills || {})) {
    const root = SKILL_ROOTS[host];
    if (!root) { plan.warnings.push('Unknown staged-skills host "' + host + '" in the record; its entries are preserved.'); continue; }
    for (const name of names) {
      if (!String(name).startsWith('motion-studio-')) { plan.warnings.push('Staged skill "' + name + '" on ' + host + ' does not use the motion-studio- prefix; preserved.'); continue; }
      plan.remove.push({ kind: 'directory', path: path.join(home, root, String(name)), reason: 'staged skill (' + host + ')' });
    }
  }

  if ((record.hostIntegrations || []).includes('claude-agent-files')) {
    plan.remove.push({ kind: 'directory-glob', path: path.join(home, AGENT_ROOT), pattern: /^motion-studio-.*\.md$/, reason: 'staged specialist agent files' });
  }

  const adapterHosts = (record.hostIntegrations || []).filter(item => typeof item === 'string' && item.endsWith('-mcp-config')).map(item => item.slice(0, -'-mcp-config'.length));
  for (const host of adapterHosts) {
    plan.remove.push({ kind: 'file', path: path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json'), reason: 'host adapter config (' + host + ')' });
  }

  const cursorEntry = (record.hostIntegrations || []).find(item => typeof item === 'string' && item.startsWith('cursor-mcp:'));
  if (cursorEntry) {
    const keys = cursorEntry.slice('cursor-mcp:'.length).split(',').filter(Boolean);
    if (keys.length) plan.remove.push({ kind: 'mcp-server-keys', path: path.join(home, '.cursor', 'mcp.json'), keys, matchCommandPrefix: appRoot, reason: 'Cursor MCP keys registered by Motion Studio (removed only when still pointing at the recorded installPath)' });
  }

  // Host-CLI registrations are not recorded individually; the installer
  // registers exactly the known server names, so removal targets those names
  // only, best effort per host CLI.
  for (const host of ['claude', 'codex']) {
    plan.remove.push({ kind: 'host-cli-registration', host, names: SERVER_NAMES, reason: host + ' MCP registrations made by the installer' });
  }

  const secretsDir = path.join(configRoot, 'motion-studio', 'secrets');
  if (removeSecrets) plan.remove.push({ kind: 'directory', path: secretsDir, reason: 'generated Premiere UXP token (--remove-secrets)' });
  else plan.preserve.push({ kind: 'directory', path: secretsDir, reason: 'generated token kept — deleting it breaks the Premiere panel until re-issued; pass --remove-secrets to delete' });

  for (const entry of record.installed || []) {
    const text = String(entry);
    const name = text.split(':')[0];
    if (removeSystemTools && !text.includes(':already-present')) plan.remove.push({ kind: 'system-tool', name, reason: 'installed by this installer (--remove-system-tools)' });
    else plan.preserve.push({ kind: 'system-tool', name, reason: text.includes(':already-present') ? 'was already present on this machine' : 'media/3D tool kept — a system-wide uninstall can break other apps; pass --remove-system-tools to remove' });
  }

  plan.preserve.push({ kind: 'directory', path: path.join(configRoot, 'motion-studio', 'adapters'), reason: 'adapter directory itself kept — only the files Motion Studio recorded are removed' });
  plan.remove.push({ kind: 'file', path: path.join(configRoot, 'motion-studio', 'install.json'), reason: 'the install record itself (removed last)' });
  return plan;
}

// Executes the computed plan. dryRun logs every action without touching the
// filesystem. mcp-server-keys entries delete only keys whose command still
// points at the recorded installPath — a key the user has since edited is
// warned about and preserved. host-cli-registration entries are best effort:
// a failing host CLI becomes a warning, never a crash.
export async function executeUninstallPlan(plan, { home, configRoot, dryRun = false, log = () => {}, runHostCli, readFileImpl = readFile, writeFileImpl = writeFile, rmImpl = rm, statImpl = stat, readdirImpl = readdir } = {}) {
  if (!plan || !Array.isArray(plan.remove) || !Array.isArray(plan.preserve)) throw new Error('executeUninstallPlan requires a computed uninstall plan.');
  const results = { removed: [], preserved: [], warnings: [...plan.warnings] };
  const removeDirectory = async target => {
    if (dryRun) { log('would remove directory ' + target); return results.removed.push({ path: target, kind: 'directory', dryRun: true }); }
    await rmImpl(target, { recursive: true, force: true });
    log('removed directory ' + target);
    results.removed.push({ path: target, kind: 'directory' });
  };
  for (const item of plan.remove) {
    if (item.kind === 'directory') { await removeDirectory(item.path); continue; }
    if (item.kind === 'file') {
      if (dryRun) { log('would remove file ' + item.path); results.removed.push({ path: item.path, kind: 'file', dryRun: true }); continue; }
      await rmImpl(item.path, { force: true });
      log('removed file ' + item.path);
      results.removed.push({ path: item.path, kind: 'file' });
      continue;
    }
    if (item.kind === 'directory-glob') {
      let entries = [];
      try { entries = await readdirImpl(item.path); } catch { continue; }
      for (const name of entries.filter(name => item.pattern.test(name))) await removeDirectory(path.join(item.path, name));
      continue;
    }
    if (item.kind === 'mcp-server-keys') {
      let config = {};
      try { config = JSON.parse(await readFileImpl(item.path, 'utf8')); }
      catch { results.warnings.push('Cursor MCP settings could not be read; keys preserved: ' + item.keys.join(', ')); continue; }
      if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) { results.warnings.push('Cursor MCP settings have no mcpServers object; keys preserved.'); continue; }
      for (const key of item.keys) {
        const server = config.mcpServers[key];
        if (!server) continue;
        const command = String(server.command || '');
        if (item.matchCommandPrefix && command && !command.startsWith(item.matchCommandPrefix)) {
          results.warnings.push('Cursor MCP key "' + key + '" no longer points at the Motion Studio install; preserved.');
          results.preserved.push({ path: item.path, kind: 'mcp-server-key', key });
          continue;
        }
        delete config.mcpServers[key];
        results.removed.push({ path: item.path, kind: 'mcp-server-key', key });
        log((dryRun ? 'would remove' : 'removed') + ' Cursor MCP key ' + key);
      }
      if (!dryRun) { await writeFileImpl(item.path, JSON.stringify(config, null, 2) + '\n'); }
      continue;
    }
    if (item.kind === 'host-cli-registration') {
      if (typeof runHostCli !== 'function') { results.warnings.push('No host-CLI runner provided; ' + item.host + ' registrations were not removed.'); continue; }
      for (const name of item.names) {
        try {
          await runHostCli(item.host, name, { dryRun });
          results.removed.push({ path: null, kind: 'host-cli-registration', host: item.host, name });
        } catch (error) { results.warnings.push(item.host + ' could not remove registration "' + name + '": ' + (error?.message ?? error)); }
      }
      continue;
    }
    if (item.kind === 'system-tool') {
      results.warnings.push('System tool "' + item.name + '" is listed for removal but package-manager removal is intentionally not automated; remove it with your package manager if desired.');
      continue;
    }
    results.warnings.push('Unknown removal kind "' + item.kind + '"; skipped.');
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const removeSecrets = argv.includes('--remove-secrets');
  const removeSystemTools = argv.includes('--remove-system-tools');
  const platform = process.platform;
  const home = os.homedir();
  const configRoot = platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const recordPath = path.join(configRoot, 'motion-studio', 'install.json');
  const record = await loadUninstallRecord(recordPath);
  const plan = computeUninstallPlan(record, { home, configRoot, removeSecrets, removeSystemTools });
  const runHostCli = async (host, name) => {
    const { spawnSync } = await import('node:child_process');
    const command = host === 'claude' ? ['claude', 'mcp', 'remove', '--scope', 'user', name] : ['codex', 'mcp', 'remove', name];
    const result = spawnSync(command[0], command.slice(1), { stdio: 'ignore', shell: false });
    if (result.status !== 0) throw new Error(host + ' mcp remove exited ' + result.status);
  };
  const results = await executeUninstallPlan(plan, { home, configRoot, dryRun, log: text => console.log(text), runHostCli });
  console.log(JSON.stringify({ recordVersion: plan.recordVersion, removed: results.removed.length, preserved: plan.preserve.length, warnings: results.warnings, dryRun }, null, 2));
}

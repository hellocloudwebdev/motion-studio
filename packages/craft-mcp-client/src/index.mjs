import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// FilmCraft + EffectCraft MCP client (architecture pivot 2026-11-14: the
// Adobe AE/Premiere stack is replaced by the open-source Storytold tools).
// Both tools expose headless MCP servers over stdio through their CLIs as
// `<app>-cli mcp` — so the same hardened client pattern applies: explicit
// producer approval for every mutation, fixed argv, no shell, no arbitrary
// code execution surface.
// Launch-args note (2026-11-19, upstream source + live check on FilmCraft
// 0.20.1): FilmCraft's CLI parser treats everything after `--` as plain
// positionals, so the previously used `filmcraft-cli -- mcp` only worked by
// accident and would silently demote any future flags (e.g. `-- --project x`)
// into file arguments. The bare `mcp` subcommand is the canonical form for
// both apps.

const CRAFT_APPS = new Set(['effectcraft', 'filmcraft']);

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function argumentDigest(args) {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex');
}

export function createCraftOperationApproval({ projectId, runId, app, toolName, args = {}, approvedBy, now = Date.now(), expiresInMs = 600000 } = {}) {
  if (!projectId || !runId || !CRAFT_APPS.has(app) || !toolName || !approvedBy?.trim()) {
    throw new Error('Project, run, craft app, tool name and approving actor are required.');
  }
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 3600000) throw new Error('Approval expiry must be between 1 ms and 1 hour.');
  return {
    approvalId: randomUUID(), approved: true, projectId, runId, app, toolName,
    argumentsSha256: argumentDigest(args), approvedBy: approvedBy.trim(),
    approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + expiresInMs).toISOString()
  };
}

export function validateCraftOperationApproval({ approval, projectId, runId, app, toolName, args = {}, now = Date.now() } = {}) {
  if (!approval || approval.approved !== true) return { valid: false, reason: 'Explicit producer approval is required for craft-tool mutations.' };
  if (approval.projectId !== projectId || approval.runId !== runId || approval.app !== app || approval.toolName !== toolName) {
    return { valid: false, reason: 'Approval scope does not match this project, run, craft app and tool.' };
  }
  if (approval.argumentsSha256 !== argumentDigest(args)) return { valid: false, reason: 'Tool arguments differ from the approved operation.' };
  const approvedAt = Date.parse(approval.approvedAt), expiresAt = Date.parse(approval.expiresAt);
  if (!approval.approvalId || !approval.approvedBy?.trim() || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= approvedAt) {
    return { valid: false, reason: 'Approval record is incomplete or has invalid timestamps.' };
  }
  if (approvedAt > now || expiresAt <= now) return { valid: false, reason: 'Approval has expired or is not yet valid.' };
  return { valid: true, approvalId: approval.approvalId, approvedBy: approval.approvedBy };
}

// Command resolution: the craft CLIs are external Rust binaries, not npm
// packages. ENV overrides win (FILMCRAFT_CLI / EFFECTCRAFT_CLI) so hosts can
// point at portable installs; the bare PATH-resolvable name comes second;
// known per-user install roots come last. `resolveCraftCommand` probes the
// candidates with fs and returns the first that exists; with none on disk it
// returns the bare name so spawn surfaces a clear PATH error.
export function craftCommandCandidates({ app, env = process.env, platform = process.platform, home = null, systemUsersRoot = platform === 'win32' ? 'C:\\Users' : null } = {}) {
  if (!CRAFT_APPS.has(app)) throw new Error('app must be effectcraft or filmcraft.');
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const homeDir = home || env.USERPROFILE || env.HOME || '';
  const list = [];
  const override = app === 'filmcraft' ? env.FILMCRAFT_CLI : env.EFFECTCRAFT_CLI;
  if (override?.trim()) list.push(override.trim());
  list.push(app + '-cli' + (platform === 'win32' ? '.exe' : ''));
  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, homeDir ? join(homeDir, 'AppData', 'Local') : '', homeDir ? join(homeDir, 'AppData', 'Roaming') : ''].filter(Boolean)) {
      list.push(join(root, 'Programs', app, 'bin', app + '-cli.exe'));
    }
    // The ArtCraft launcher's per-user MSI layout installs into the profile
    // root of the user who ran it — which is not always the current user
    // (shared machines). Enumerate every profile directory.
    if (systemUsersRoot) {
      try {
        for (const entry of readdirSync(systemUsersRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('$') || entry.name === 'Public' || entry.name === 'Default') continue;
          const profile = join(systemUsersRoot, entry.name);
          list.push(join(profile, app, app + '-cli.exe'));
          list.push(join(profile, 'AppData', 'Local', 'Programs', app, 'bin', app + '-cli.exe'));
        }
      } catch { /* unreadable users root: the PATH fallback still applies */ }
    }
  } else if (platform === 'darwin') {
    list.push(join('/Applications', capitalized(app) + '.app', 'Contents', 'MacOS', app + '-cli'), '/usr/local/bin/' + app + '-cli', '/usr/bin/' + app + '-cli');
  } else {
    list.push('/usr/local/bin/' + app + '-cli', '/usr/bin/' + app + '-cli');
  }
  return list;
}

function capitalized(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export async function resolveCraftCommand({ app, env = process.env, platform = process.platform, home = null, probe = null } = {}) {
  const candidates = craftCommandCandidates({ app, env, platform, home });
  const exists = probe || (async candidate => { try { await access(candidate); return true; } catch { return false; } });
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  // With nothing on disk, fall back to the bare PATH-resolvable name so the
  // eventual spawn surfaces a clear, honest "command not found" error.
  return app + '-cli' + (platform === 'win32' ? '.exe' : '');
}

export function craftMcpArgs(app) {
  if (!CRAFT_APPS.has(app)) throw new Error('app must be effectcraft or filmcraft.');
  return ['mcp'];
}

// The craft tools ship no documented read-only/eval env switches (unlike the
// old Adobe MCPs); mutation safety is enforced by the approval gate below, so
// the environment passes through untouched — nothing to strip, nothing to fake.
export function createCraftMcpEnvironment({ baseEnv = process.env } = {}) {
  return { ...baseEnv };
}

export async function connectCraftMcp({ app, allowEdits = false, command, args, env = process.env, clientName = 'motion-studio', version = '0.6.0-alpha.1' } = {}) {
  if (!CRAFT_APPS.has(app)) throw new Error('app must be effectcraft or filmcraft.');
  const executable = command ?? await resolveCraftCommand({ app, env });
  const transport = new StdioClientTransport({
    command: executable,
    args: args ?? craftMcpArgs(app),
    env: createCraftMcpEnvironment({ baseEnv: env }),
    stderr: 'pipe'
  });
  const client = new Client({ name: clientName + '-' + app, version }, { capabilities: {} });
  await client.connect(transport);
  return {
    app,
    client,
    transport,
    async listTools() { return client.listTools(); },
    async callTool(name, args = {}, options = {}) {
      if (allowEdits) {
        const check = validateCraftOperationApproval({ ...options, app, toolName: name, args });
        if (!check.valid) throw new Error(check.reason);
      }
      return client.callTool({ name, arguments: args });
    },
    async close() { await client.close(); }
  };
}

// Connection verification stays tool-name-agnostic on purpose: both craft
// CLIs are alpha and their tool surface evolves, so verification asserts a
// live server advertising at least one tool, plus records the surface.
export async function verifyCraftConnection({ app, ...options } = {}) {
  const connection = await connectCraftMcp({ ...options, app, allowEdits: false });
  try {
    const tools = await connection.listTools();
    const names = (tools.tools || []).map(tool => tool.name);
    if (!names.length) throw new Error('The ' + app + ' MCP server is connected but advertises no tools.');
    return { serverConnected: true, app, toolCount: names.length, tools: names };
  } finally { await connection.close(); }
}

export const verifyEffectCraftConnection = options => verifyCraftConnection({ ...options, app: 'effectcraft' });
export const verifyFilmcraftConnection = options => verifyCraftConnection({ ...options, app: 'filmcraft' });

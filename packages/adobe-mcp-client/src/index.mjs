import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);

export function resolveAdobeMcpEntries({ resolve = require.resolve } = {}) {
  return {
    afterEffects: resolve('@kumoproductions/mcp-aftereffects'),
    premiere: resolve('premiere-pro-mcp')
  };
}

export function createAdobeMcpEnvironment({ app = 'afterEffects', allowEdits = false, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  if (app === 'afterEffects') {
    env.AE_MCP_READONLY = allowEdits ? '0' : '1';
    if (allowEdits) env.AE_MCP_ALLOW_CATEGORIES = 'comp,layer,text,transform,keyframe,render';
    else delete env.AE_MCP_ALLOW_CATEGORIES;
    delete env.AE_MCP_ENABLE_EVAL;
    return env;
  }
  if (app === 'premiere') {
    env.PREMIERE_MCP_CAPABILITIES = allowEdits ? 'inspect,edit,export,filesystem' : 'inspect';
    env.PREMIERE_MCP_TOOL_PACKS = 'inspection';
    env.PREMIERE_MCP_TOOL_LIST = allowEdits
      ? 'verify_premiere_connection,get_project_info,import_media,create_sequence_from_clips,get_active_sequence,get_sequence_structure,save_project,export_sequence,verify_delivery_file'
      : 'verify_premiere_connection,get_project_info,get_active_sequence,get_sequence_structure';
    delete env.PREMIERE_MCP_UNSAFE_SCRIPT;
    return env;
  }
  throw new Error('Unknown Adobe MCP target: ' + app);
}

export function premiereTokenFilePath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const configRoot = platform === 'win32'
    ? (env.APPDATA || join(home, 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME || join(home, '.config'));
  return join(configRoot, 'motion-studio', 'secrets', 'premiere-uxp-token');
}

export async function connectAdobeMcp({ app, allowEdits = false, entry, clientName = 'motion-studio', version = '0.4.0-alpha.1', env = process.env } = {}) {
  if (!['afterEffects', 'premiere'].includes(app)) throw new Error('app must be afterEffects or premiere.');
  const resolvedEntry = entry || resolveAdobeMcpEntries()[app];
  if (!resolvedEntry) throw new Error('The ' + app + ' MCP package is not installed.');
  const childEnv = createAdobeMcpEnvironment({ app, allowEdits, baseEnv: env });
  if (app === 'premiere' && !childEnv.PREMIERE_UXP_TOKEN) {
    try {
      const token = (await readFile(premiereTokenFilePath({ env }), 'utf8')).trim();
      if (token) childEnv.PREMIERE_UXP_TOKEN = token;
    } catch {}
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolvedEntry],
    env: childEnv,
    stderr: 'pipe'
  });
  const client = new Client({ name: clientName + '-' + app, version }, { capabilities: {} });
  await client.connect(transport);
  return {
    app,
    client,
    transport,
    async listTools() { return client.listTools(); },
    async callTool(name, args = {}) { return client.callTool({ name, arguments: args }); },
    async close() { await client.close(); }
  };
}

export async function verifyAfterEffectsConnection(options = {}) {
  const connection = await connectAdobeMcp({ ...options, app: 'afterEffects', allowEdits: false });
  try {
    const tools = await connection.listTools();
    const names = (tools.tools || []).map(tool => tool.name);
    if (!names.includes('ae_context')) throw new Error('After Effects MCP is connected but ae_context is not advertised.');
    const context = await connection.callTool('ae_context', {});
    return { serverConnected: true, app: 'afterEffects', toolCount: names.length, contextAvailable: !context.isError, result: context };
  } finally { await connection.close(); }
}

export async function verifyPremiereConnection(options = {}) {
  const connection = await connectAdobeMcp({ ...options, app: 'premiere', allowEdits: false });
  try {
    const tools = await connection.listTools();
    const names = (tools.tools || []).map(tool => tool.name);
    if (!names.includes('verify_premiere_connection')) throw new Error('Premiere MCP does not expose verify_premiere_connection. Check the installed upstream version.');
    const result = await connection.callTool('verify_premiere_connection', {});
    return { serverConnected: true, app: 'premiere', toolCount: names.length, hostVerified: !result.isError, result };
  } finally { await connection.close(); }
}

import { createRequire } from 'node:module';
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
    delete env.AE_MCP_ENABLE_EVAL;
    return env;
  }
  if (app === 'premiere') {
    env.PREMIERE_MCP_CAPABILITIES = allowEdits ? 'inspect,edit,export,filesystem' : 'inspect';
    env.PREMIERE_MCP_TOOL_PACKS = 'inspection';
    delete env.PREMIERE_MCP_UNSAFE_SCRIPT;
    return env;
  }
  throw new Error('Unknown Adobe MCP target: ' + app);
}

export async function connectAdobeMcp({ app, allowEdits = false, entry, clientName = 'motion-studio', version = '0.3.0-alpha.1', env = process.env } = {}) {
  if (!['afterEffects', 'premiere'].includes(app)) throw new Error('app must be afterEffects or premiere.');
  const resolvedEntry = entry || resolveAdobeMcpEntries()[app];
  if (!resolvedEntry) throw new Error('The ' + app + ' MCP package is not installed.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolvedEntry],
    env: createAdobeMcpEnvironment({ app, allowEdits, baseEnv: env }),
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

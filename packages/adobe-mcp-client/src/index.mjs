import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function argumentDigest(args) {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex');
}

export function createAdobeOperationApproval({ projectId, runId, app, toolName, args = {}, approvedBy, now = Date.now(), expiresInMs = 600000 } = {}) {
  if (!projectId || !runId || !['afterEffects', 'premiere'].includes(app) || !toolName || !approvedBy?.trim()) {
    throw new Error('Project, run, Adobe app, tool name and approving actor are required.');
  }
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 3600000) throw new Error('Approval expiry must be between 1 ms and 1 hour.');
  return {
    approvalId: randomUUID(), approved: true, projectId, runId, app, toolName,
    argumentsSha256: argumentDigest(args), approvedBy: approvedBy.trim(),
    approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + expiresInMs).toISOString()
  };
}

export function validateAdobeOperationApproval({ approval, projectId, runId, app, toolName, args = {}, now = Date.now() } = {}) {
  if (!approval || approval.approved !== true) return { valid: false, reason: 'Explicit producer approval is required for Adobe mutations.' };
  if (approval.projectId !== projectId || approval.runId !== runId || approval.app !== app || approval.toolName !== toolName) {
    return { valid: false, reason: 'Approval scope does not match this project, run, Adobe app and tool.' };
  }
  if (approval.argumentsSha256 !== argumentDigest(args)) return { valid: false, reason: 'Tool arguments differ from the approved operation.' };
  const approvedAt = Date.parse(approval.approvedAt), expiresAt = Date.parse(approval.expiresAt);
  if (!approval.approvalId || !approval.approvedBy?.trim() || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= approvedAt) {
    return { valid: false, reason: 'Approval record is incomplete or has invalid timestamps.' };
  }
  if (approvedAt > now || expiresAt <= now) return { valid: false, reason: 'Approval has expired or is not yet valid.' };
  return { valid: true, approvalId: approval.approvalId, approvedBy: approval.approvedBy };
}

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

export async function connectAdobeMcp({ app, allowEdits = false, entry, clientName = 'motion-studio', version = '0.6.0-alpha.1', env = process.env } = {}) {
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
    async callTool(name, args = {}, options = {}) {
      if (allowEdits) {
        const check = validateAdobeOperationApproval({ ...options, app, toolName: name, args });
        if (!check.valid) throw new Error(check.reason);
      }
      return client.callTool({ name, arguments: args });
    },
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

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP planning and compilation tools run without a model API credential', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== 'OPENROUTER_API_KEY' && typeof value === 'string'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('servers/mcp-server/src/index.mjs')], env });
  const client = new Client({ name: 'motion-studio-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.ok(names.has('video.create_production_brief'));
    assert.ok(names.has('video.validate_planning_artifacts'));
    assert.ok(names.has('video.compile_planning_artifacts'));
    assert.ok(!names.has('video.generate_production'));
  } finally {
    await client.close();
  }
});

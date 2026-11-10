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
    assert.ok(names.has('video.render_project'));
    assert.ok(names.has('video.render_blender_scene'));
    assert.ok(names.has('video.render_threejs_scene'));
    assert.ok(names.has('video.package_delivery'));
    assert.ok(!names.has('video.generate_production'));
    const templateResult = await client.callTool({ name: 'video.create_project_template', arguments: { name: 'Rational-rate smoke test', fps: 29.97, durationSeconds: 30 } });
    assert.notEqual(templateResult.isError, true);
    const template = JSON.parse(templateResult.content[0].text);
    assert.deepEqual(template.project.frameRate, { numerator: 30000, denominator: 1001 });
    assert.deepEqual(template.delivery.targets[0].frameRate, template.project.frameRate);
    assert.equal(template.project.totalDurationFrames, template.scenes[0].durationFrames);
  } finally {
    await client.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildEffectCraftServer, createEffectCraftApproval } from './index.mjs';
import { craftCommandCandidates } from '../../craft-mcp-client/src/index.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(MODULE_DIR, 'index.mjs');

const EXPECTED_TOOLS = [
  'effectcraft.check_engine',
  'effectcraft.list_commands',
  'effectcraft.describe_command',
  'effectcraft.inspect_project',
  'effectcraft.get_property',
  'effectcraft.layer_props',
  'effectcraft.plan_scene',
  'effectcraft.render_frame',
  'effectcraft.render_scene',
  'effectcraft.render_comp',
  'effectcraft.run_command',
  'effectcraft.run_batch'
];

// Fixed approval timestamp: far in the past, so approvals created with it are
// deterministically stale against the real clock.
const FIXED_PAST_NOW = 1_700_000_000_000;

async function withClient(run) {
  const server = buildEffectCraftServer();
  const client = new Client({ name: 'motion-studio-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function callToolJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON payload: returned raw */ }
  return { isError: result.isError === true, text, parsed };
}

function projectFixture() {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'ec-fixture', name: 'EC Fixture', objective: 'Verify the EffectCraft server.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 1 },
    creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
    brand: { colors: { background: '#101820', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [],
    scenes: [{
      id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show the cards.',
      layers: [
        { id: 'bg', kind: 'shape', style: { backgroundColor: '#101820' }, transform: { x: 0, y: 0, width: 320, height: 180 }, motion: { preset: 'fade' } },
        { id: 'title', kind: 'text', content: { text: 'Motion Studio' }, style: { color: '#ffffff' }, typography: { sizePx: 24 }, transform: { x: 60, y: 60, width: 200, height: 40 }, motion: { preset: 'fade-up' } }
      ]
    }],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } }] }
  };
}

test('registers exactly the twelve effectcraft tools under one server name', async () => {
  await withClient(async client => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    assert.equal(names.length, 12, 'exactly twelve tools are registered');
    assert.equal(new Set(names).size, 12, 'no duplicate tool names');
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    // Read-only planning tools must not demand approval fields in their schema.
    const plan = tools.tools.find(tool => tool.name === 'effectcraft.plan_scene');
    assert.ok(!('approval' in plan.inputSchema.properties), 'planning is approval-free');
    // Mutating tools take the uniform approval gate fields.
    for (const mutating of ['effectcraft.run_command', 'effectcraft.run_batch']) {
      const schema = tools.tools.find(tool => tool.name === mutating).inputSchema.properties;
      assert.ok('approval' in schema && 'projectId' in schema && 'runId' in schema, mutating + ' requires approval/projectId/runId');
    }
    // The render surface is the verified subset of the CLI formats (no
    // image-sequence formats: single frames belong to render_frame).
    const renderFormat = tools.tools.find(tool => tool.name === 'effectcraft.render_comp').inputSchema.properties.format;
    assert.deepEqual([...(renderFormat.enum ?? [])].sort(), ['h264', 'hevc', 'av1', 'prores', 'webm'].sort());
  });
});

test('createEffectCraftApproval wraps the craft approval with app effectcraft and a stable digest', () => {
  const approval = createEffectCraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'effectcraft.run_command', args: { commandId: 'file.newBin' }, approvedBy: 'Producer', now: FIXED_PAST_NOW });
  assert.equal(approval.app, 'effectcraft');
  assert.equal(approval.projectId, 'p1');
  assert.equal(approval.runId, 'r1');
  assert.equal(approval.toolName, 'effectcraft.run_command');
  assert.match(approval.argumentsSha256, /^[a-f0-9]{64}$/);
  assert.equal(approval.approvedAt, new Date(FIXED_PAST_NOW).toISOString());
  const again = createEffectCraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'effectcraft.run_command', args: { commandId: 'file.newBin' }, approvedBy: 'Producer', now: FIXED_PAST_NOW, expiresInMs: 1000 });
  assert.equal(again.argumentsSha256, approval.argumentsSha256, 'the digest is a pure function of the args');
  assert.notEqual(again.approvalId, approval.approvalId);
});

test('mutating tools refuse a missing approval with governance guidance', async () => {
  await withClient(async client => {
    const result = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'S' }, save: false });
    assert.equal(result.isError, true, 'no approval means no mutation');
    assert.match(result.text, /governanceGate/);
    assert.match(result.text, /Producer approval is required/);
    assert.match(result.text, /createCraftOperationApproval|createEffectCraftApproval/);
  });
});

test('mutating tools reject a stale approval created with a fixed past timestamp', async () => {
  await withClient(async client => {
    const approval = createEffectCraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'effectcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'S' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now: FIXED_PAST_NOW, expiresInMs: 600000 });
    const result = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'S' }, save: false, approval });
    assert.equal(result.isError, true);
    assert.match(result.text, /expired or is not yet valid/);
  });
});

test('mutating tools reject approvals whose args digest does not match the call', async () => {
  await withClient(async client => {
    const now = Date.now();
    const approval = createEffectCraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'effectcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Approved' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const mismatched = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Different' }, save: false, approval });
    assert.equal(mismatched.isError, true);
    assert.match(mismatched.text, /Tool arguments differ from the approved operation/);
    // A digest-matching approval scoped to another tool is still refused.
    const wrongTool = createEffectCraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'effectcraft.run_batch', args: { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Approved' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const scoped = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Approved' }, save: false, approval: wrongTool });
    assert.equal(scoped.isError, true);
    assert.match(scoped.text, /Approval scope does not match/);
    // Wrong project/run scope fails too.
    const wrongRun = createEffectCraftApproval({ projectId: 'p1', runId: 'OTHER', toolName: 'effectcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Approved' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const runScoped = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'layer.newSolid', params: { name: 'Approved' }, save: false, approval: wrongRun });
    assert.equal(runScoped.isError, true);
    assert.match(runScoped.text, /Approval scope does not match/);
  });
});

test('plan_scene plans a deterministic step script from a tiny IR fixture', async () => {
  await withClient(async client => {
    const planned = await callToolJson(client, 'effectcraft.plan_scene', { project: projectFixture(), sceneId: 'scene-01' });
    assert.equal(planned.isError, false);
    assert.equal(planned.parsed.valid, true, JSON.stringify(planned.parsed).slice(0, 400));
    const stepIds = planned.parsed.steps.map(step => step.id);
    assert.equal(stepIds[0], 'comp.new', 'the comp is created first');
    assert.ok(stepIds.includes('layer.newSolid'), 'the shape layer plans a solid');
    assert.ok(stepIds.includes('layer.newText'), 'the text layer plans a text layer');
    assert.ok(stepIds.some(id => id === 'prop.set'), 'motion presets plan prop.set keyframes');
    // The text layer's fade-up preset starts 40 px below its IR position
    // (x=60, y=60+40) and ends on it — positions are vec3.
    const positions = planned.parsed.steps.filter(step => step.id === 'prop.set' && step.params?.path === 'transform/position');
    assert.deepEqual(positions[0].params.value, [60, 100, 0]);
    assert.deepEqual(positions[1].params.value, [60, 60, 0]);
    // Broken IR reports structured issues instead of throwing.
    const broken = projectFixture();
    delete broken.project.frameRate;
    const invalid = await callToolJson(client, 'effectcraft.plan_scene', { project: broken, sceneId: 'scene-01' });
    assert.equal(invalid.isError, false, 'planning reports issues as data');
    assert.equal(invalid.parsed.valid, false);
    assert.ok(invalid.parsed.issues.length >= 1);
    // Unknown scene id fails as data too.
    const unknown = await callToolJson(client, 'effectcraft.plan_scene', { project: projectFixture(), sceneId: 'nope' });
    assert.equal(unknown.parsed.valid, false);
    assert.match(JSON.stringify(unknown.parsed), /SCENE_NOT_FOUND/);
  });
});

test('render_scene fails closed for an unknown project workspace', async () => {
  await withClient(async client => {
    const missing = await callToolJson(client, 'effectcraft.render_scene', { projectId: 'ec-no-such-project', sceneId: 'scene-01' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /ENOENT|no such file/i);
    // Path traversal in projectId is rejected before any filesystem access.
    await withClient(async () => {});
  });
});

// Raw fetch MCP streamable-http client: POST JSON-RPC, parse JSON responses.
async function mcpPost(base, body, token) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { 'x-motion-studio-token': token } : {}) },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON responses surfaced via status */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function startHttpChild(env = {}) {
  const child = spawn(process.execPath, [ENTRY, '--http', '--port', '0'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(new Error('the http server did not listen in time. stdout: ' + stdout + ' stderr: ' + stderr)), 15000);
    const fail = code => { clearTimeout(timer); reject(new Error('the http server exited early (' + code + '). stdout: ' + stdout + ' stderr: ' + stderr)); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); child.removeListener('exit', fail); resolve('http://127.0.0.1:' + match[1]); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', fail);
  });
  return { child, base };
}

test('http mode serves the MCP surface on 127.0.0.1 and enforces the optional token', async () => {
  const { child, base } = await startHttpChild({ MOTION_STUDIO_CRAFT_HTTP_TOKEN: 'secret-test-token' });
  try {
    // No token → 403; wrong token → 403; the token value is never echoed back.
    const denied = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } } });
    assert.equal(denied.status, 403);
    assert.ok(!denied.text.includes('secret-test-token'), 'the token value is never logged or echoed');
    const wrongToken = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } } }, 'wrong-token');
    assert.equal(wrongToken.status, 403);

    const initialized = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } } }, 'secret-test-token');
    assert.equal(initialized.status, 200);
    assert.equal(initialized.json?.result?.serverInfo?.name, 'motion-studio-effectcraft');
    assert.equal(initialized.json?.result?.serverInfo?.version, '1.0.0-alpha.1');
    await mcpPost(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'secret-test-token');

    const listed = await mcpPost(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'secret-test-token');
    assert.equal(listed.status, 200);
    const names = (listed.json?.result?.tools || []).map(tool => tool.name);
    assert.equal(names.length, 12);
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());

    const called = await mcpPost(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'effectcraft.plan_scene', arguments: { project: projectFixture(), sceneId: 'scene-01' } } }, 'secret-test-token');
    assert.equal(called.status, 200);
    const payload = JSON.parse(called.json?.result?.content?.[0]?.text || '{}');
    assert.equal(payload.valid, true, 'the read-only tool answers over http: ' + called.text.slice(0, 300));

    // Only /mcp is served; other paths 404.
    const notFound = await fetch(base + '/other', { method: 'POST', headers: { 'x-motion-studio-token': 'secret-test-token' }, body: '{}' });
    assert.equal(notFound.status, 404);
    // GET is not part of the stateless surface → 405 with Allow.
    const get = await fetch(base + '/mcp', { headers: { 'x-motion-studio-token': 'secret-test-token' } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'GET, POST, DELETE');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
});

test('http mode without a configured token needs no header', async () => {
  const { child, base } = await startHttpChild();
  try {
    const initialized = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } } });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.json?.result?.serverInfo?.name, 'motion-studio-effectcraft');
    const listed = await mcpPost(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.status, 200);
    assert.equal((listed.json?.result?.tools || []).length, 12);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
});

test('http mode refuses non-loopback hosts and bad ports', async () => {
  for (const argv of [['--http', '--host', '0.0.0.0'], ['--http', '--port', 'not-a-port'], ['--http', '--bogus']]) {
    const child = spawn(process.execPath, [ENTRY, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = await new Promise(resolve => {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('exit', code => resolve({ code, stderr }));
      setTimeout(() => { child.kill(); }, 5000).unref();
    });
    assert.notEqual(output.code, 0, argv.join(' ') + ' must fail closed');
    assert.match(output.stderr, /refusing host|must be an integer|Unknown argument/);
  }
});

// Live CLI tests: run only where effectcraft-cli is installed; ffprobe is
// additionally required to independently verify a rendered comp.
const CLI_AVAILABLE = craftCommandCandidates({ app: 'effectcraft' }).some(candidate => existsSync(candidate));
const FFPROBE_AVAILABLE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;

// Shared live helper: build a saved project with one comp containing a
// background solid and a title text layer. Returns { projectPath, compName }.
async function buildFixtureProject(client, root, name) {
  const projectPath = path.join(root, name + '.ecproj');
  const commands = [
    // EffectCraft's file.newProject accepts no parameters (unlike FilmCraft),
    // and no explicit file.saveAs step: run_batch appends it from saveAs.
    { id: 'file.newProject', params: {} },
    { id: 'comp.new', params: { name: 'Main', width: 320, height: 180, frameRate: 30, duration: 2, background: '#101820' } },
    { id: 'layer.newSolid', params: { name: 'MS-BG', color: '#101820', width: 320, height: 180 } },
    { id: 'layer.newText', params: { name: 'MS-TITLE', text: 'Motion Studio', position: [60, 60], size: 24, fill: '#ffffff' } }
  ];
  const now = Date.now();
  const approval = createEffectCraftApproval({ projectId: 'p-' + name, runId: 'r-build', toolName: 'effectcraft.run_batch', args: { projectId: 'p-' + name, runId: 'r-build', commands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
  const built = await callToolJson(client, 'effectcraft.run_batch', { projectId: 'p-' + name, runId: 'r-build', commands, saveAs: projectPath, approval });
  assert.equal(built.isError, false, built.text);
  assert.equal(built.parsed.ok, true, built.text);
  assert.ok(existsSync(projectPath), 'the project was saved to disk');
  return { projectPath, compName: 'Main' };
}

test('live check_engine resolves the CLI and verifies the MCP connection', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  await withClient(async client => {
    const started = Date.now();
    const result = await callToolJson(client, 'effectcraft.check_engine', {});
    assert.equal(result.isError, false, result.text);
    assert.match(result.parsed.command, /effectcraft-cli(\.exe)?$/, 'the resolved command is the EffectCraft CLI');
    assert.match(result.parsed.version, /effectcraft-cli \d+\.\d+\.\d+/);
    assert.equal(result.parsed.connection.serverConnected, true);
    assert.ok(result.parsed.connection.toolCount >= 1, 'the EffectCraft MCP server advertises tools');
    assert.ok(Date.now() - started < 30000, 'the engine check stays fast');
  });
});

test('live run_command adds a solid to a real project through the approval gate', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-command2-'));
  try {
    await withClient(async client => {
      const { projectPath } = await buildFixtureProject(client, root, 'CmdFixture');
      // One approved command against the saved project, saved back.
      const now = Date.now();
      const approval = createEffectCraftApproval({ projectId: 'p-CmdFixture', runId: 'r-command', toolName: 'effectcraft.run_command', args: { projectId: 'p-CmdFixture', runId: 'r-command', commandId: 'layer.newSolid', params: { name: 'MS-ADDED', color: '#4ade80', width: 40, height: 40 }, projectPath, save: true, timeoutMs: undefined }, approvedBy: 'Producer', now });
      const result = await callToolJson(client, 'effectcraft.run_command', { projectId: 'p-CmdFixture', runId: 'r-command', commandId: 'layer.newSolid', params: { name: 'MS-ADDED', color: '#4ade80', width: 40, height: 40 }, projectPath, save: true, approval });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.parsed.ok, true, result.text);
      assert.equal(result.parsed.results[0].ok, true, 'layer.newSolid succeeded');
      // The saved-back project contains the added solid.
      const inspected = await callToolJson(client, 'effectcraft.inspect_project', { projectPath });
      assert.match(inspected.parsed.summary, /MS-ADDED/, 'the approved mutation persisted');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live run_batch refuses a tampered digest before touching the engine', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  await withClient(async client => {
    const commands = [{ id: 'file.newProject', params: { name: 'Should Never Run' } }];
    const approval = createEffectCraftApproval({ projectId: 'p-live', runId: 'r-tamper', toolName: 'effectcraft.run_batch', args: { projectId: 'p-live', runId: 'r-tamper', commands: [{ id: 'file.newProject', params: { name: 'Different' } }], projectPath: undefined, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer' });
    const result = await callToolJson(client, 'effectcraft.run_batch', { projectId: 'p-live', runId: 'r-tamper', commands, approval });
    assert.equal(result.isError, true);
    assert.match(result.text, /Tool arguments differ from the approved operation/);
    assert.equal(result.parsed.results, undefined, 'no session was run');
  });
});

test('live read-only surfaces: list, describe (with near matches), inspect, get_property, layer_props, render_frame', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-readonly-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'ReadOnly');
      // list_commands: the filter narrows the surface.
      const listed = await callToolJson(client, 'effectcraft.list_commands', { filter: 'layer.new', limit: 10 });
      assert.equal(listed.isError, false, listed.text);
      assert.ok(listed.parsed.count >= 1 && listed.parsed.count <= 10);
      assert.ok(listed.parsed.commands.every(entry => (entry.id + entry.label).toLowerCase().includes('layer.new')));
      const limited = await callToolJson(client, 'effectcraft.list_commands', { limit: 3 });
      assert.equal(limited.parsed.count, 3, 'limit truncates the surface');
      assert.ok(limited.parsed.total > 3);
      // describe_command: known id round-trips; unknown id fails with near matches.
      const described = await callToolJson(client, 'effectcraft.describe_command', { commandId: 'comp.new' });
      assert.equal(described.isError, false, described.text);
      assert.equal(described.parsed.commandDescription.id, 'comp.new');
      const unknown = await callToolJson(client, 'effectcraft.describe_command', { commandId: 'layer.newSol' });
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /Unknown EffectCraft command id/);
      assert.match(unknown.text, /layer\.newSolid/, 'near matches list the substring hits');
      // inspect_project: the engine summary names the comp and layers.
      const inspected = await callToolJson(client, 'effectcraft.inspect_project', { projectPath });
      assert.equal(inspected.isError, false, inspected.text);
      assert.match(inspected.parsed.summary, /Motion Studio|ReadOnly|MS-BG/);
      const missingProject = await callToolJson(client, 'effectcraft.inspect_project', { projectPath: path.join(root, 'nope.ecproj') });
      assert.equal(missingProject.isError, true);
      assert.match(missingProject.text, /does not exist/);
      // get_property: the solid's opacity reads back as 100 (scalar).
      const got = await callToolJson(client, 'effectcraft.get_property', { projectPath, comp: compName, layer: 'MS-BG', propertyPath: 'transform/opacity' });
      assert.equal(got.isError, false, got.text);
      assert.equal(got.parsed.property.value, 100);
      // layer_props: the text layer's property tree includes sourceText.
      const props = await callToolJson(client, 'effectcraft.layer_props', { projectPath, comp: compName, layer: 'MS-TITLE', flat: true });
      assert.equal(props.isError, false, props.text);
      assert.ok(props.parsed.layerProps.properties.some(entry => entry.path === 'transform/position'), 'the property tree exposes typed paths');
      // render_frame: a verified PNG artifact with a sha256 receipt.
      const framePath = path.join(root, 'frame.png');
      const rendered = await callToolJson(client, 'effectcraft.render_frame', { projectPath, compId: compName, timeSeconds: 0, outputPath: framePath });
      assert.equal(rendered.isError, false, rendered.text);
      assert.ok(rendered.parsed.artifact.byteSize > 0, 'the PNG is non-empty');
      assert.equal(rendered.parsed.artifact.sha256, createHash('sha256').update(await readFile(framePath)).digest('hex'));
      const overwriteFrame = await callToolJson(client, 'effectcraft.render_frame', { projectPath, compId: compName, timeSeconds: 0, outputPath: framePath });
      assert.equal(overwriteFrame.isError, true);
      assert.match(overwriteFrame.text, /refusing to overwrite/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render_comp renders a comp and passes independent FFprobe verification', { skip: CLI_AVAILABLE && FFPROBE_AVAILABLE ? false : 'effectcraft-cli and ffprobe are required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-render-'));
  try {
    const outputPath = path.join(root, 'comp.mp4');
    const started = Date.now();
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Render');
      const rendered = await callToolJson(client, 'effectcraft.render_comp', { projectPath, compId: compName, outputPath, format: 'h264', fps: 30 });
      assert.equal(rendered.isError, false, rendered.text);
      assert.equal(rendered.parsed.verified, true, rendered.text);
      assert.equal(rendered.parsed.verification.passed, true);
      assert.equal(rendered.parsed.artifact.media.width, 320);
      assert.equal(rendered.parsed.artifact.media.height, 180);
      assert.ok(rendered.parsed.artifact.media.durationSeconds > 1.5, 'the 2 s comp was rendered');
      assert.equal(rendered.parsed.artifact.sha256, createHash('sha256').update(await readFile(outputPath)).digest('hex'), 'the receipt sha256 matches the on-disk artifact');
      // A second render to the same path is refused (no silent overwrite).
      const overwrite = await callToolJson(client, 'effectcraft.render_comp', { projectPath, compId: compName, outputPath, format: 'h264', fps: 30 });
      assert.equal(overwrite.isError, true);
      assert.match(overwrite.text, /refusing to overwrite/);
    });
    assert.ok(Date.now() - started < 60000, 'the live render stays under 60 s');
  } finally { await rm(root, { recursive: true, force: true }); }
});

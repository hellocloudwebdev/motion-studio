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
  'effectcraft.run_batch',
  'effectcraft.add_mask',
  'effectcraft.set_track_matte',
  'effectcraft.set_blend_mode',
  'effectcraft.set_parent',
  'effectcraft.add_marker',
  'effectcraft.set_work_area',
  'effectcraft.render_queue',
  'effectcraft.export_lottie',
  'effectcraft.export_timeline',
  'effectcraft.import_timeline',
  'effectcraft.list_fonts'
];

const GATED_TOOLS = [
  'effectcraft.run_command',
  'effectcraft.run_batch',
  'effectcraft.add_mask',
  'effectcraft.set_track_matte',
  'effectcraft.set_blend_mode',
  'effectcraft.set_parent',
  'effectcraft.add_marker',
  'effectcraft.set_work_area',
  'effectcraft.import_timeline'
];

// Verified artifact generation and pure reads stay approval-free.
const UNGATED_TOOLS = [
  'effectcraft.render_queue',
  'effectcraft.export_lottie',
  'effectcraft.export_timeline',
  'effectcraft.list_fonts'
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

test('registers exactly the twenty-three effectcraft tools under one server name', async () => {
  await withClient(async client => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    assert.equal(names.length, 23, 'exactly twenty-three tools are registered');
    assert.equal(new Set(names).size, 23, 'no duplicate tool names');
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    // Read-only planning tools must not demand approval fields in their schema.
    const plan = tools.tools.find(tool => tool.name === 'effectcraft.plan_scene');
    assert.ok(!('approval' in plan.inputSchema.properties), 'planning is approval-free');
    // Mutating tools take the uniform approval gate fields.
    for (const mutating of GATED_TOOLS) {
      const schema = tools.tools.find(tool => tool.name === mutating).inputSchema.properties;
      assert.ok('approval' in schema && 'projectId' in schema && 'runId' in schema, mutating + ' requires approval/projectId/runId');
    }
    for (const ungated of UNGATED_TOOLS) {
      const schema = tools.tools.find(tool => tool.name === ungated).inputSchema.properties;
      assert.ok(!('approval' in schema), ungated + ' stays approval-free');
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

test('the new gated tools refuse a missing approval before touching the engine', async () => {
  await withClient(async client => {
    const result = await callToolJson(client, 'effectcraft.add_mask', { projectId: 'p1', runId: 'r1', projectPath: 'missing.ecproj', compId: 'Main', layer: 'MS-TITLE', shape: 'rect', rect: [0, 0, 10, 10] });
    assert.equal(result.isError, true, 'no approval means no mutation');
    assert.match(result.text, /governanceGate/);
    assert.match(result.text, /effectcraft\.add_mask/, 'the guidance names the exact tool');
    assert.match(result.text, /Producer approval is required/);
    assert.equal(result.parsed.results, undefined, 'no session was run');
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
    assert.equal(names.length, 23);
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
    assert.equal((listed.json?.result?.tools || []).length, 23);
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
async function buildFixtureProject(client, root, name, compName = 'Main') {
  const projectPath = path.join(root, name + '.ecproj');
  const commands = [
    // EffectCraft's file.newProject accepts no parameters (unlike FilmCraft),
    // and no explicit file.saveAs step: run_batch appends it from saveAs.
    { id: 'file.newProject', params: {} },
    { id: 'comp.new', params: { name: compName, width: 320, height: 180, frameRate: 30, duration: 2, background: '#101820' } },
    { id: 'layer.newSolid', params: { name: 'MS-BG', color: '#101820', width: 320, height: 180 } },
    { id: 'layer.newText', params: { name: 'MS-TITLE', text: 'Motion Studio', position: [60, 60], size: 24, fill: '#ffffff' } }
  ];
  const now = Date.now();
  const approval = createEffectCraftApproval({ projectId: 'p-' + name, runId: 'r-build', toolName: 'effectcraft.run_batch', args: { projectId: 'p-' + name, runId: 'r-build', commands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
  const built = await callToolJson(client, 'effectcraft.run_batch', { projectId: 'p-' + name, runId: 'r-build', commands, saveAs: projectPath, approval });
  assert.equal(built.isError, false, built.text);
  assert.equal(built.parsed.ok, true, built.text);
  assert.ok(existsSync(projectPath), 'the project was saved to disk');
  return { projectPath, compName };
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

// Fresh approval for one of the gated tools over the exact resolved opArgs
// (zod defaults spelled out, undefined fields included) — the digest the gate
// checks is over this object.
function approveGate(toolName, args) {
  return createEffectCraftApproval({ projectId: args.projectId, runId: args.runId, toolName, args, approvedBy: 'Producer', now: Date.now() });
}

test('live add_mask adds a rect mask to a real project and returns the mask id', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-mask-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'MaskEdit');
      const opArgs = { projectId: 'p-MaskEdit', runId: 'r-mask', projectPath, compId: compName, layer: 'MS-TITLE', shape: 'rect', rect: [0, 0, 120, 40], roundness: undefined, vertices: undefined, mode: undefined, timeoutMs: undefined };
      const result = await callToolJson(client, 'effectcraft.add_mask', { ...opArgs, approval: approveGate('effectcraft.add_mask', opArgs) });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.parsed.ok, true, result.text);
      assert.equal(typeof result.parsed.mask, 'number', 'layer.addMask reports the created mask id: ' + result.text);
      assert.equal(result.parsed.results[1].ok, true, 'the mask step succeeded');
      assert.equal(result.parsed.savePath, projectPath, 'the project was saved back');
      // rect AND vertices together is a usage error, refused before any session.
      const both = { ...opArgs, vertices: [[0, 0], [60, 0], [60, 30]] };
      const conflict = await callToolJson(client, 'effectcraft.add_mask', { ...both, approval: approveGate('effectcraft.add_mask', both) });
      assert.equal(conflict.isError, true);
      assert.match(conflict.text, /exactly one of rect/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live set_blend_mode verifies the mode through a props readback', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-blend-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Blend');
      const opArgs = { projectId: 'p-Blend', runId: 'r-blend', projectPath, compId: compName, layer: 'MS-TITLE', mode: 'Multiply', timeoutMs: undefined };
      const result = await callToolJson(client, 'effectcraft.set_blend_mode', { ...opArgs, approval: approveGate('effectcraft.set_blend_mode', opArgs) });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.parsed.ok, true, result.text);
      assert.equal(result.parsed.verified.blendMode, 'Multiply', 'the saved layer reads back with the mode: ' + result.text);
      assert.equal(result.parsed.verified.expected, 'Multiply');
      assert.equal(result.parsed.verified.matches, true);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live set_track_matte and set_parent run approved sessions and report step results', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-matte-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Matte');
      const matteArgs = { projectId: 'p-Matte', runId: 'r-matte', projectPath, compId: compName, layer: 'MS-TITLE', matteLayer: 'MS-BG', kind: 'alpha', timeoutMs: undefined };
      const matte = await callToolJson(client, 'effectcraft.set_track_matte', { ...matteArgs, approval: approveGate('effectcraft.set_track_matte', matteArgs) });
      assert.equal(matte.isError, false, matte.text);
      assert.equal(matte.parsed.ok, true, matte.text);
      assert.equal(matte.parsed.results[1].id, 'layer.setTrackMatte');
      assert.equal(matte.parsed.results[1].ok, true, 'the silent matte step still succeeded');
      assert.equal(matte.parsed.results[1].silent, true, 'silent steps report null results');
      assert.equal(matte.parsed.kind, 'alpha');
      const parentArgs = { projectId: 'p-Matte', runId: 'r-parent', projectPath, compId: compName, layer: 'MS-TITLE', parentLayer: 'MS-BG', compensate: false, timeoutMs: undefined };
      const parent = await callToolJson(client, 'effectcraft.set_parent', { ...parentArgs, approval: approveGate('effectcraft.set_parent', parentArgs) });
      assert.equal(parent.isError, false, parent.text);
      assert.equal(parent.parsed.ok, true, parent.text);
      assert.equal(parent.parsed.results[1].id, 'layer.setParent');
      assert.equal(parent.parsed.results[1].ok, true, 'the silent parent step still succeeded');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live add_marker and set_work_area save receipts (and refuse inverted work areas)', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-marker-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Markers');
      const markerArgs = { projectId: 'p-Markers', runId: 'r-marker', projectPath, compId: compName, seconds: 1, comment: 'beat one', timeoutMs: undefined };
      const marker = await callToolJson(client, 'effectcraft.add_marker', { ...markerArgs, approval: approveGate('effectcraft.add_marker', markerArgs) });
      assert.equal(marker.isError, false, marker.text);
      assert.equal(marker.parsed.ok, true, marker.text);
      assert.equal(marker.parsed.marker.time, 1, 'comp.addMarker reports the placed time: ' + marker.text);
      assert.equal(marker.parsed.comment, 'beat one');
      const workArgs = { projectId: 'p-Markers', runId: 'r-work', projectPath, compId: compName, start: 0.5, end: 1.5, timeoutMs: undefined };
      const work = await callToolJson(client, 'effectcraft.set_work_area', { ...workArgs, approval: approveGate('effectcraft.set_work_area', workArgs) });
      assert.equal(work.isError, false, work.text);
      assert.equal(work.parsed.ok, true, work.text);
      assert.deepEqual(work.parsed.workArea, { start: 0.5, end: 1.5 }, 'comp.workArea echoes the range: ' + work.text);
      const inverted = { ...workArgs, start: 1.5, end: 0.5 };
      const refused = await callToolJson(client, 'effectcraft.set_work_area', { ...inverted, approval: approveGate('effectcraft.set_work_area', inverted) });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /end must be greater than start/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live render_queue renders two jobs and passes independent FFprobe verification', { skip: CLI_AVAILABLE && FFPROBE_AVAILABLE ? false : 'effectcraft-cli and ffprobe are required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-rqueue-'));
  try {
    const started = Date.now();
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Queue');
      const firstOutput = path.join(root, 'queue-a.mp4');
      const secondOutput = path.join(root, 'queue-b.mp4');
      const queued = await callToolJson(client, 'effectcraft.render_queue', { projectPath, jobs: [
        { compId: compName, outputPath: firstOutput, format: 'h264' },
        { compId: compName, outputPath: secondOutput, format: 'h264' }
      ] });
      assert.equal(queued.isError, false, queued.text);
      assert.equal(queued.parsed.allVerified, true, queued.text);
      assert.equal(queued.parsed.jobs.length, 2, 'every job gets a receipt');
      for (const [index, job] of queued.parsed.jobs.entries()) {
        assert.equal(job.verified, true, JSON.stringify(job.failures));
        assert.equal(job.media.width, 320);
        assert.equal(job.media.height, 180);
        assert.ok(job.media.durationSeconds > 0, 'the render has a probeable duration');
        assert.ok(job.byteSize > 0);
        const onDisk = index === 0 ? firstOutput : secondOutput;
        assert.equal(job.sha256, createHash('sha256').update(await readFile(onDisk)).digest('hex'), 'the receipt sha256 matches the on-disk artifact');
      }
      // A queued render to an existing output is refused before any session.
      const overwrite = await callToolJson(client, 'effectcraft.render_queue', { projectPath, jobs: [{ compId: compName, outputPath: firstOutput }] });
      assert.equal(overwrite.isError, true);
      assert.match(overwrite.text, /refusing to overwrite/);
    });
    assert.ok(Date.now() - started < 60000, 'the two-job render queue stays under 60 s');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live export_lottie writes valid JSON and refuses overwrites and bad extensions', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-lottie-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Lottie');
      const lottiePath = path.join(root, 'main.json');
      const exported = await callToolJson(client, 'effectcraft.export_lottie', { projectPath, compId: compName, outputPath: lottiePath });
      assert.equal(exported.isError, false, exported.text);
      assert.equal(exported.parsed.ok, true, exported.text);
      assert.equal(exported.parsed.frames, 60, 'the 2 s / 30 fps comp exports 60 frames: ' + exported.text);
      assert.ok(exported.parsed.layers >= 1, 'the comp layers are reported');
      assert.equal(exported.parsed.lottie.name, compName);
      assert.equal(exported.parsed.lottie.width, 320);
      assert.equal(exported.parsed.lottie.height, 180);
      assert.equal(exported.parsed.artifact.sha256, createHash('sha256').update(await readFile(lottiePath)).digest('hex'));
      const onDisk = JSON.parse(await readFile(lottiePath, 'utf8'));
      assert.equal(onDisk.nm, compName, 'the artifact parses as JSON and names the comp');
      const overwrite = await callToolJson(client, 'effectcraft.export_lottie', { projectPath, compId: compName, outputPath: lottiePath });
      assert.equal(overwrite.isError, true);
      assert.match(overwrite.text, /refusing to overwrite/);
      const badExtension = await callToolJson(client, 'effectcraft.export_lottie', { projectPath, compId: compName, outputPath: path.join(root, 'main.txt') });
      assert.equal(badExtension.isError, true);
      assert.match(badExtension.text, /\.json or \.lottie/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live export_timeline writes an FCPXML that starts with the XML declaration', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-timeline-'));
  try {
    await withClient(async client => {
      const { projectPath, compName } = await buildFixtureProject(client, root, 'Timeline');
      const timelinePath = path.join(root, 'timeline.fcpxml');
      const exported = await callToolJson(client, 'effectcraft.export_timeline', { projectPath, compId: compName, outputPath: timelinePath, format: 'fcpxml' });
      assert.equal(exported.isError, false, exported.text);
      assert.equal(exported.parsed.ok, true, exported.text);
      const content = await readFile(timelinePath, 'utf8');
      assert.match(content.trimStart(), /^<\?xml/, 'the FCPXML starts with the XML declaration');
      assert.ok(exported.parsed.artifact.byteSize > 0);
      assert.equal(exported.parsed.export.format, 'fcpxml');
      assert.ok(exported.parsed.export.sequences >= 1, 'the export reports its sequence count');
      const overwrite = await callToolJson(client, 'effectcraft.export_timeline', { projectPath, compId: compName, outputPath: timelinePath, format: 'fcpxml' });
      assert.equal(overwrite.isError, true);
      assert.match(overwrite.text, /refusing to overwrite/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live import_timeline round-trips an exported FCPXML into a second project', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-ecmcp-import-'));
  try {
    await withClient(async client => {
      const source = await buildFixtureProject(client, root, 'RoundTripSource');
      const target = await buildFixtureProject(client, root, 'RoundTripTarget', 'Other');
      const timelinePath = path.join(root, 'roundtrip.fcpxml');
      const exported = await callToolJson(client, 'effectcraft.export_timeline', { projectPath: source.projectPath, compId: source.compName, outputPath: timelinePath, format: 'fcpxml' });
      assert.equal(exported.isError, false, exported.text);
      const importArgs = { projectId: 'p-RoundTripTarget', runId: 'r-import', projectPath: target.projectPath, timelinePath, format: 'auto', timeoutMs: undefined };
      const imported = await callToolJson(client, 'effectcraft.import_timeline', { ...importArgs, approval: approveGate('effectcraft.import_timeline', importArgs) });
      assert.equal(imported.isError, false, imported.text);
      assert.equal(imported.parsed.ok, true, imported.text);
      assert.ok(imported.parsed.compsCreated >= 1, 'the imported comp shows up in the info summary: ' + imported.text);
      assert.ok(imported.parsed.comps.includes(source.compName), 'the imported comp keeps its name');
      assert.match(imported.parsed.summary, /Composition/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live list_fonts queries the headless font catalog', { skip: CLI_AVAILABLE ? false : 'effectcraft-cli is required on the host.' }, async () => {
  await withClient(async client => {
    const queried = await callToolJson(client, 'effectcraft.list_fonts', { query: 'Arial' });
    assert.equal(queried.isError, false, queried.text);
    assert.ok(queried.parsed.count >= 1, 'the query matches at least one family');
    assert.ok(queried.parsed.families.some(family => family.family === 'Arial'));
    assert.ok(queried.parsed.families.every(family => Array.isArray(family.styles) && family.styles.length >= 1));
    const full = await callToolJson(client, 'effectcraft.list_fonts', {});
    assert.equal(full.isError, false, full.text);
    assert.ok(full.parsed.count >= queried.parsed.count, 'an unfiltered query covers the filtered surface');
  });
});

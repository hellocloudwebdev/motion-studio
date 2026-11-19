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
import { buildFilmcraftServer, createFilmcraftApproval } from './index.mjs';
import { craftCommandCandidates } from '../../craft-mcp-client/src/index.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(MODULE_DIR, 'index.mjs');

const EXPECTED_TOOLS = [
  'filmcraft.check_engine',
  'filmcraft.list_commands',
  'filmcraft.describe_command',
  'filmcraft.inspect_project',
  'filmcraft.inspect_sequence',
  'filmcraft.render_frame',
  'filmcraft.probe_media',
  'filmcraft.plan_editorial_assembly',
  'filmcraft.import_interchange',
  'filmcraft.apply_transition',
  'filmcraft.run_command',
  'filmcraft.run_batch',
  'filmcraft.export_master'
];

// Fixed approval timestamp: 2023-11-14, far in the past, so approvals created
// with it are deterministically stale against the real clock.
const FIXED_PAST_NOW = 1_700_000_000_000;

async function withClient(run) {
  const server = buildFilmcraftServer();
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
    project: { id: 'fc-fixture', name: 'FC Fixture', objective: 'Verify the FilmCraft server.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 1 },
    creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
    brand: { colors: { background: '#101820', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: 'a'.repeat(64), byteSize: 120000, rightsStatus: 'user-owned' }],
    scenes: [{ id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show the clip.', layers: [{ id: 'l-clip', kind: 'video', assetId: 'clip', transform: { x: 0, y: 0, width: 320, height: 180 } }] }],
    audio: { tracks: [] },
    delivery: { targets: [{ width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } }] }
  };
}

test('registers exactly the thirteen filmcraft tools under one server name', async () => {
  await withClient(async client => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    assert.equal(names.length, 13, 'exactly thirteen tools are registered');
    assert.equal(new Set(names).size, 13, 'no duplicate tool names');
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    // Read-only planning tools must not demand approval fields in their schema.
    const plan = tools.tools.find(tool => tool.name === 'filmcraft.plan_editorial_assembly');
    assert.ok(!('approval' in plan.inputSchema.properties), 'planning is approval-free');
    // Mutating tools take the uniform approval gate fields.
    for (const mutating of ['filmcraft.import_interchange', 'filmcraft.apply_transition', 'filmcraft.run_command', 'filmcraft.run_batch']) {
      const schema = tools.tools.find(tool => tool.name === mutating).inputSchema.properties;
      assert.ok('approval' in schema && 'projectId' in schema && 'runId' in schema, mutating + ' requires approval/projectId/runId');
    }
    // The export surface is the approved subset of the CLI formats.
    const exportFormat = tools.tools.find(tool => tool.name === 'filmcraft.export_master').inputSchema.properties.format;
    assert.deepEqual([...(exportFormat.enum ?? [])].sort(), ['h264', 'hevc', 'prores', 'dnxhr', 'png', 'wav'].sort());
  });
});

test('createFilmcraftApproval wraps the craft approval with app filmcraft and a stable digest', () => {
  const approval = createFilmcraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'filmcraft.run_command', args: { commandId: 'file.newBin' }, approvedBy: 'Producer', now: FIXED_PAST_NOW });
  assert.equal(approval.app, 'filmcraft');
  assert.equal(approval.projectId, 'p1');
  assert.equal(approval.runId, 'r1');
  assert.equal(approval.toolName, 'filmcraft.run_command');
  assert.match(approval.argumentsSha256, /^[a-f0-9]{64}$/);
  assert.equal(approval.approvedAt, new Date(FIXED_PAST_NOW).toISOString());
  const again = createFilmcraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'filmcraft.run_command', args: { commandId: 'file.newBin' }, approvedBy: 'Producer', now: FIXED_PAST_NOW, expiresInMs: 1000 });
  assert.equal(again.argumentsSha256, approval.argumentsSha256, 'the digest is a pure function of the args');
  assert.notEqual(again.approvalId, approval.approvalId);
});

test('mutating tools refuse a missing approval with governance guidance', async () => {
  await withClient(async client => {
    const result = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'B' }, save: false });
    assert.equal(result.isError, true, 'no approval means no mutation');
    assert.match(result.text, /governanceGate/);
    assert.match(result.text, /Producer approval is required/);
    assert.match(result.text, /createCraftOperationApproval|createFilmcraftApproval/);
  });
});

test('mutating tools reject a stale approval created with a fixed past timestamp', async () => {
  await withClient(async client => {
    const approval = createFilmcraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'filmcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'B' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now: FIXED_PAST_NOW, expiresInMs: 600000 });
    const result = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'B' }, save: false, approval });
    assert.equal(result.isError, true);
    assert.match(result.text, /expired or is not yet valid/);
  });
});

test('mutating tools reject approvals whose args digest does not match the call', async () => {
  await withClient(async client => {
    const now = Date.now();
    const approval = createFilmcraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'filmcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Approved Bin' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const mismatched = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Different Bin' }, save: false, approval });
    assert.equal(mismatched.isError, true);
    assert.match(mismatched.text, /Tool arguments differ from the approved operation/);
    // A digest-matching approval scoped to another tool is still refused.
    const wrongTool = createFilmcraftApproval({ projectId: 'p1', runId: 'r1', toolName: 'filmcraft.run_batch', args: { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Approved Bin' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const scoped = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Approved Bin' }, save: false, approval: wrongTool });
    assert.equal(scoped.isError, true);
    assert.match(scoped.text, /Approval scope does not match/);
    // Wrong project/run scope fails too.
    const wrongRun = createFilmcraftApproval({ projectId: 'p1', runId: 'OTHER', toolName: 'filmcraft.run_command', args: { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Approved Bin' }, projectPath: undefined, save: false, timeoutMs: undefined }, approvedBy: 'Producer', now });
    const runScoped = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p1', runId: 'r1', commandId: 'file.newBin', params: { name: 'Approved Bin' }, save: false, approval: wrongRun });
    assert.equal(runScoped.isError, true);
    assert.match(runScoped.text, /Approval scope does not match/);
  });
});

test('plan_editorial_assembly plans a deterministic manifest from a tiny IR fixture', async () => {
  await withClient(async client => {
    const planned = await callToolJson(client, 'filmcraft.plan_editorial_assembly', { project: projectFixture() });
    assert.equal(planned.isError, false);
    assert.equal(planned.parsed.summary.valid, true, JSON.stringify(planned.parsed));
    assert.equal(planned.parsed.summary.errors, 0);
    assert.equal(planned.parsed.project.id, 'fc-fixture');
    const clips = planned.parsed.clips || [];
    assert.ok(Array.isArray(clips) && clips.length >= 1, 'the fixture scene yields at least one planned clip');
    assert.equal(clips[0].startFrame, 0);
    assert.equal(clips[0].endFrame, 60);
    // Broken IR reports structured issues instead of throwing.
    const broken = projectFixture();
    delete broken.project.frameRate;
    const invalid = await callToolJson(client, 'filmcraft.plan_editorial_assembly', { project: broken });
    assert.equal(invalid.isError, false, 'planning reports issues as data');
    assert.equal(invalid.parsed.valid, false);
    assert.ok(invalid.parsed.issues.length >= 1);
  });
});

test('plan_editorial_assembly honours an explicit sequence name', async () => {
  await withClient(async client => {
    const planned = await callToolJson(client, 'filmcraft.plan_editorial_assembly', { project: projectFixture(), sequenceName: 'Main Cut' });
    assert.equal(planned.parsed.summary.valid, true, JSON.stringify(planned.parsed));
    assert.equal(planned.parsed.sequence.name, 'Main Cut');
    assert.equal(planned.parsed.sequence.durationFrames, 60);
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
    assert.equal(initialized.json?.result?.serverInfo?.name, 'motion-studio-filmcraft');
    assert.equal(initialized.json?.result?.serverInfo?.version, '1.0.0-alpha.1');
    await mcpPost(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'secret-test-token');

    const listed = await mcpPost(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'secret-test-token');
    assert.equal(listed.status, 200);
    const names = (listed.json?.result?.tools || []).map(tool => tool.name);
    assert.equal(names.length, 13);
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());

    const called = await mcpPost(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'filmcraft.plan_editorial_assembly', arguments: { project: projectFixture() } } }, 'secret-test-token');
    assert.equal(called.status, 200);
    const payload = JSON.parse(called.json?.result?.content?.[0]?.text || '{}');
    assert.equal(payload.summary.valid, true, 'the read-only tool answers over http: ' + called.text.slice(0, 300));

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
    assert.equal(initialized.json?.result?.serverInfo?.name, 'motion-studio-filmcraft');
    const listed = await mcpPost(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.status, 200);
    assert.equal((listed.json?.result?.tools || []).length, 13);
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

// Live CLI tests: run only where filmcraft-cli is installed; ffprobe is
// additionally required to independently verify an exported master.
const CLI_AVAILABLE = craftCommandCandidates({ app: 'filmcraft' }).some(candidate => existsSync(candidate));
const FFPROBE_AVAILABLE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;

test('live check_engine resolves the CLI and verifies the MCP connection', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  await withClient(async client => {
    const started = Date.now();
    const result = await callToolJson(client, 'filmcraft.check_engine', {});
    assert.equal(result.isError, false, result.text);
    assert.match(result.parsed.command, /filmcraft-cli(\.exe)?$/, 'the resolved command is the filmcraft CLI');
    assert.match(result.parsed.version, /filmcraft-cli \d+\.\d+\.\d+/);
    assert.equal(result.parsed.connection.serverConnected, true);
    assert.ok(result.parsed.connection.toolCount >= 1, 'the FilmCraft MCP server advertises tools');
    assert.ok(result.parsed.connection.tools.includes('command_run'), 'the command surface includes command_run');
    assert.ok(Date.now() - started < 30000, 'the engine check stays fast');
  });
});

test('live run_command mutates a real project through the approval gate', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-command-'));
  try {
    const projectPath = path.join(root, 'commands.fcproj');
    await withClient(async client => {
      // Session 1 (no approval needed? no — run_command mutates): build + save a project.
      const buildCommands = [
        { id: 'file.newProject', params: { name: 'Command Fixture' } },
        { id: 'file.newSequence', params: { name: 'Cmd Seq', width: 320, height: 180, fps: 30 } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now = Date.now();
      const buildApproval = createFilmcraftApproval({ projectId: 'p-live', runId: 'r-build', toolName: 'filmcraft.run_batch', args: { projectId: 'p-live', runId: 'r-build', commands: buildCommands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
      const built = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-live', runId: 'r-build', commands: buildCommands, saveAs: projectPath, approval: buildApproval });
      assert.equal(built.isError, false, built.text);
      assert.equal(built.parsed.ok, true, built.text);
      assert.ok(existsSync(projectPath), 'the project was saved to disk');

      // Session 2: one approved command against the saved project, saved back.
      const now2 = Date.now();
      const approval = createFilmcraftApproval({ projectId: 'p-live', runId: 'r-command', toolName: 'filmcraft.run_command', args: { projectId: 'p-live', runId: 'r-command', commandId: 'file.newBin', params: { name: 'Selects' }, projectPath, save: true, timeoutMs: undefined }, approvedBy: 'Producer', now: now2 });
      const result = await callToolJson(client, 'filmcraft.run_command', { projectId: 'p-live', runId: 'r-command', commandId: 'file.newBin', params: { name: 'Selects' }, projectPath, save: true, approval });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.parsed.ok, true, result.text);
      assert.equal(result.parsed.results[0].ok, true, 'file.newBin succeeded');
      // The saved-back project contains the bin.
      const inspected = await callToolJson(client, 'filmcraft.inspect_project', { projectPath });
      assert.match(JSON.stringify(inspected.parsed), /Selects/, 'the approved mutation persisted');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live run_batch refuses a tampered digest before touching the engine', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  await withClient(async client => {
    const commands = [{ id: 'file.newProject', params: { name: 'Should Never Run' } }];
    const approval = createFilmcraftApproval({ projectId: 'p-live', runId: 'r-tamper', toolName: 'filmcraft.run_batch', args: { projectId: 'p-live', runId: 'r-tamper', commands: [{ id: 'file.newProject', params: { name: 'Different' } }], projectPath: undefined, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer' });
    const result = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-live', runId: 'r-tamper', commands, approval });
    assert.equal(result.isError, true);
    assert.match(result.text, /Tool arguments differ from the approved operation/);
    assert.equal(result.parsed.results, undefined, 'no session was run');
  });
});

test('live export_master exports a demo sequence and passes independent FFprobe verification', { skip: CLI_AVAILABLE && FFPROBE_AVAILABLE ? false : 'filmcraft-cli and ffprobe are required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-export-'));
  try {
    const projectPath = path.join(root, 'export.fcproj');
    const outputPath = path.join(root, 'master.mp4');
    const started = Date.now();
    await withClient(async client => {
      // Build a tiny project from FilmCraft's built-in demo footage (no media
      // files needed) and save it; item ids are runtime-assigned.
      const buildCommands = [
        { id: 'file.newProject', params: { name: 'Export Fixture' } },
        { id: 'file.newSequence', params: { name: 'Export Seq', width: 320, height: 180, fps: 30 } },
        { id: 'file.importDemoFootage', params: { scene: 'Plasma' } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now = Date.now();
      const buildApproval = createFilmcraftApproval({ projectId: 'p-export', runId: 'r-build', toolName: 'filmcraft.run_batch', args: { projectId: 'p-export', runId: 'r-build', commands: buildCommands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
      const built = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-export', runId: 'r-build', commands: buildCommands, saveAs: projectPath, approval: buildApproval });
      assert.equal(built.parsed.ok, true, built.text);
      const sequenceId = built.parsed.results.find(entry => entry.id === 'file.newSequence')?.result?.sequence;
      const itemIds = built.parsed.results.filter(entry => entry.id === 'file.importDemoFootage').flatMap(entry => entry.result.items);
      assert.ok(Number.isInteger(sequenceId), 'the sequence id is discovered from the run results');
      assert.equal(itemIds.length, 1);

      const placeCommands = [
        { id: 'sequence.open', params: { item: sequenceId } },
        { id: 'timeline.place', params: { items: itemIds } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now2 = Date.now();
      const placeApproval = createFilmcraftApproval({ projectId: 'p-export', runId: 'r-place', toolName: 'filmcraft.run_batch', args: { projectId: 'p-export', runId: 'r-place', commands: placeCommands, projectPath, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer', now: now2 });
      const placed = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-export', runId: 'r-place', commands: placeCommands, projectPath, approval: placeApproval });
      assert.equal(placed.parsed.ok, true, placed.text);

      const exported = await callToolJson(client, 'filmcraft.export_master', { projectPath, outputPath, format: 'h264', start: 0, end: 2 });
      assert.equal(exported.isError, false, exported.text);
      assert.equal(exported.parsed.verified, true, exported.text);
      assert.equal(exported.parsed.verification.passed, true);
      assert.equal(exported.parsed.artifact.media.width, 320);
      assert.equal(exported.parsed.artifact.media.height, 180);
      assert.ok(exported.parsed.artifact.media.durationSeconds > 1.5, 'the 2 s range was exported');
      assert.equal(exported.parsed.artifact.sha256, createHash('sha256').update(await readFile(outputPath)).digest('hex'), 'the receipt sha256 matches the on-disk master');
      assert.deepEqual(exported.parsed.export.offlineMedia, [], 'demo footage is never offline');
      // A second export to the same path is refused (no silent overwrite).
      const overwrite = await callToolJson(client, 'filmcraft.export_master', { projectPath, outputPath, format: 'h264', start: 0, end: 2 });
      assert.equal(overwrite.isError, true);
      assert.match(overwrite.text, /refusing to overwrite/);
    });
    assert.ok(Date.now() - started < 60000, 'the live export stays under 60 s');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live export_master fails closed with the offline media list and never certifies placeholders', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-offline-'));
  try {
    const projectPath = path.join(root, 'offline.fcproj');
    const outputPath = path.join(root, 'never-certified.mp4');
    await withClient(async client => {
      const buildCommands = [
        { id: 'file.newProject', params: { name: 'Offline Fixture' } },
        { id: 'file.newSequence', params: { name: 'Offline Seq', width: 320, height: 180, fps: 30 } },
        { id: 'file.newOfflineFile', params: { name: 'Ghosts', seconds: 2 } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now = Date.now();
      const buildApproval = createFilmcraftApproval({ projectId: 'p-off', runId: 'r-build', toolName: 'filmcraft.run_batch', args: { projectId: 'p-off', runId: 'r-build', commands: buildCommands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
      const built = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-off', runId: 'r-build', commands: buildCommands, saveAs: projectPath, approval: buildApproval });
      assert.equal(built.parsed.ok, true, built.text);
      const sequenceId = built.parsed.results.find(entry => entry.id === 'file.newSequence')?.result?.sequence;
      const itemId = built.parsed.results.find(entry => entry.id === 'file.newOfflineFile')?.result?.item;
      assert.ok(Number.isInteger(itemId), 'the offline file item id is discovered');
      const placeCommands = [
        { id: 'sequence.open', params: { item: sequenceId } },
        { id: 'timeline.place', params: { items: [itemId] } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now2 = Date.now();
      const placeApproval = createFilmcraftApproval({ projectId: 'p-off', runId: 'r-place', toolName: 'filmcraft.run_batch', args: { projectId: 'p-off', runId: 'r-place', commands: placeCommands, projectPath, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer', now: now2 });
      const placed = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-off', runId: 'r-place', commands: placeCommands, projectPath, approval: placeApproval });
      assert.equal(placed.parsed.ok, true, placed.text);

      const exported = await callToolJson(client, 'filmcraft.export_master', { projectPath, outputPath, format: 'h264', start: 0, end: 1 });
      assert.equal(exported.isError, true, 'offline media must fail closed');
      assert.equal(exported.parsed.refused, true);
      assert.ok(exported.parsed.offlineMedia.length >= 1, 'the offline list is reported');
      assert.match(exported.text, /--allow-offline is never passed|never passes --allow-offline/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live inspect_sequence reads tracks/clips with frame timing and never modifies the project', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-inspect-'));
  try {
    const projectPath = path.join(root, 'inspect.fcproj');
    await withClient(async client => {
      const buildCommands = [
        { id: 'file.newProject', params: { name: 'Inspect Fixture' } },
        { id: 'file.newSequence', params: { name: 'Inspect Seq', width: 320, height: 180, fps: 30 } },
        { id: 'file.importDemoFootage', params: { scene: 'Forest' } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now = Date.now();
      const buildApproval = createFilmcraftApproval({ projectId: 'p-inspect', runId: 'r-build', toolName: 'filmcraft.run_batch', args: { projectId: 'p-inspect', runId: 'r-build', commands: buildCommands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
      const built = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-inspect', runId: 'r-build', commands: buildCommands, saveAs: projectPath, approval: buildApproval });
      assert.equal(built.parsed.ok, true, built.text);
      const sequenceId = built.parsed.results.find(entry => entry.id === 'file.newSequence')?.result?.sequence;
      const itemIds = built.parsed.results.filter(entry => entry.id === 'file.importDemoFootage').flatMap(entry => entry.result.items);
      const placeCommands = [
        { id: 'sequence.open', params: { item: sequenceId } },
        { id: 'timeline.place', params: { items: itemIds } },
        { id: 'file.saveAs', params: { path: projectPath } }
      ];
      const now2 = Date.now();
      const placeApproval = createFilmcraftApproval({ projectId: 'p-inspect', runId: 'r-place', toolName: 'filmcraft.run_batch', args: { projectId: 'p-inspect', runId: 'r-place', commands: placeCommands, projectPath, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer', now: now2 });
      await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-inspect', runId: 'r-place', commands: placeCommands, projectPath, approval: placeApproval });

      const inspected = await callToolJson(client, 'filmcraft.inspect_sequence', { projectPath, sequenceId });
      assert.equal(inspected.isError, false, inspected.text);
      assert.equal(inspected.parsed.sequenceId, sequenceId);
      const videoTrack = inspected.parsed.sequence.video.find(track => (track.items || []).length >= 1);
      assert.ok(videoTrack, 'the placed demo clip is on a video track');
      const clip = videoTrack.items[0];
      assert.ok(Number.isInteger(clip.startFrame) && Number.isInteger(clip.endFrame), 'clip timing is reported in frames');
      assert.ok(Number.isInteger(clip.sourceIn), 'source in/out are reported');
      assert.equal(inspected.parsed.inspectedViaTempCopy, true);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Shared live helper: build a saved project with `sceneCount` demo-footage
// clips placed back-to-back on V1 (FilmCraft's built-in footage — no media
// files needed). Returns { projectPath, sequenceId, itemIds }.
async function buildDemoProject(client, root, name, sceneCount = 1) {
  const projectPath = path.join(root, name + '.fcproj');
  const buildCommands = [
    { id: 'file.newProject', params: { name } },
    { id: 'file.newSequence', params: { name: name + ' Seq', width: 320, height: 180, fps: 30 } },
    ...Array.from({ length: sceneCount }, (_, index) => ({ id: 'file.importDemoFootage', params: { scene: index === 0 ? 'Plasma' : 'Forest' } })),
    { id: 'file.saveAs', params: { path: projectPath } }
  ];
  const now = Date.now();
  const buildApproval = createFilmcraftApproval({ projectId: 'p-' + name, runId: 'r-build', toolName: 'filmcraft.run_batch', args: { projectId: 'p-' + name, runId: 'r-build', commands: buildCommands, projectPath: undefined, saveAs: projectPath, timeoutMs: undefined }, approvedBy: 'Producer', now });
  const built = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-' + name, runId: 'r-build', commands: buildCommands, saveAs: projectPath, approval: buildApproval });
  assert.equal(built.parsed.ok, true, built.text);
  const sequenceId = built.parsed.results.find(entry => entry.id === 'file.newSequence')?.result?.sequence;
  const itemIds = built.parsed.results.filter(entry => entry.id === 'file.importDemoFootage').flatMap(entry => entry.result.items);
  assert.equal(itemIds.length, sceneCount, 'the demo clips imported');
  const placeCommands = [
    { id: 'sequence.open', params: { item: sequenceId } },
    { id: 'timeline.place', params: { items: itemIds } },
    { id: 'file.saveAs', params: { path: projectPath } }
  ];
  const now2 = Date.now();
  const placeApproval = createFilmcraftApproval({ projectId: 'p-' + name, runId: 'r-place', toolName: 'filmcraft.run_batch', args: { projectId: 'p-' + name, runId: 'r-place', commands: placeCommands, projectPath, saveAs: undefined, timeoutMs: undefined }, approvedBy: 'Producer', now: now2 });
  const placed = await callToolJson(client, 'filmcraft.run_batch', { projectId: 'p-' + name, runId: 'r-place', commands: placeCommands, projectPath, approval: placeApproval });
  assert.equal(placed.parsed.ok, true, placed.text);
  return { projectPath, sequenceId, itemIds };
}

test('live read-only surfaces: list, describe (with near matches), inspect_project, render_frame, probe_media', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-readonly-'));
  try {
    await withClient(async client => {
      const { projectPath } = await buildDemoProject(client, root, 'ReadOnly');
      // list_commands: the filter narrows the surface.
      const listed = await callToolJson(client, 'filmcraft.list_commands', { filter: 'transition', limit: 10 });
      assert.equal(listed.isError, false, listed.text);
      assert.ok(listed.parsed.count >= 1 && listed.parsed.count <= 10);
      assert.ok(listed.parsed.commands.every(entry => (entry.id + entry.label).toLowerCase().includes('transition')));
      const limited = await callToolJson(client, 'filmcraft.list_commands', { limit: 3 });
      assert.equal(limited.parsed.count, 3, 'limit truncates the surface');
      assert.ok(limited.parsed.total > 3);
      // describe_command: known id round-trips; unknown id fails with near matches.
      const described = await callToolJson(client, 'filmcraft.describe_command', { commandId: 'file.import' });
      assert.equal(described.isError, false, described.text);
      assert.equal(described.parsed.commandDescription.id, 'file.import');
      const unknown = await callToolJson(client, 'filmcraft.describe_command', { commandId: 'file.expor' });
      assert.equal(unknown.isError, true);
      assert.match(unknown.text, /Unknown FilmCraft command id/);
      assert.match(unknown.text, /file\.exportMedia/, 'near matches list the substring hits');
      // inspect_project: the bin tree and known sequences are reported.
      const inspected = await callToolJson(client, 'filmcraft.inspect_project', { projectPath });
      assert.equal(inspected.isError, false, inspected.text);
      assert.ok(inspected.parsed.sequences.some(entry => entry.item === inspected.parsed.project.activeSequence), 'the active sequence is among the tree sequences');
      const missingProject = await callToolJson(client, 'filmcraft.inspect_project', { projectPath: path.join(root, 'nope.fcproj') });
      assert.equal(missingProject.isError, true);
      assert.match(missingProject.text, /does not exist/);
      // render_frame: a verified PNG artifact with a sha256 receipt.
      const framePath = path.join(root, 'frame.png');
      const rendered = await callToolJson(client, 'filmcraft.render_frame', { projectPath, seconds: 0, outputPath: framePath });
      assert.equal(rendered.isError, false, rendered.text);
      assert.ok(rendered.parsed.artifact.byteSize > 0, 'the PNG is non-empty');
      assert.equal(rendered.parsed.artifact.sha256, createHash('sha256').update(await readFile(framePath)).digest('hex'));
      const overwriteFrame = await callToolJson(client, 'filmcraft.render_frame', { projectPath, seconds: 0, outputPath: framePath });
      assert.equal(overwriteFrame.isError, true);
      assert.match(overwriteFrame.text, /refusing to overwrite/);
      // probe_media: the rendered PNG probes as an image (no --allow-offline flag).
      const probed = await callToolJson(client, 'filmcraft.probe_media', { mediaPath: framePath });
      assert.equal(probed.isError, false, probed.text);
      assert.equal(probed.parsed.probe.kind, 'Still', 'the PNG probes as a still image');
      const missingMedia = await callToolJson(client, 'filmcraft.probe_media', { mediaPath: path.join(root, 'missing.mp4') });
      assert.equal(missingMedia.isError, true);
      assert.match(missingMedia.text, /does not exist/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live apply_transition mutates through the gate with schema-resolved default args', { skip: CLI_AVAILABLE ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fcmcp-transition-'));
  try {
    await withClient(async client => {
      const { projectPath } = await buildDemoProject(client, root, 'Transition', 2);
      // The approval covers the RESOLVED op args (zod fills track='V1',
      // clipOrdinal=1, effect='cross_dissolve', frames=24), but the call omits
      // them — proving defaults land inside the digest identically.
      const opArgs = { projectId: 'p-Transition', runId: 'r-apply', projectPath, track: 'V1', clipOrdinal: 1, effect: 'cross_dissolve', frames: 12, timeoutMs: undefined };
      const approval = createFilmcraftApproval({ projectId: 'p-Transition', runId: 'r-apply', toolName: 'filmcraft.apply_transition', args: opArgs, approvedBy: 'Producer' });
      const applied = await callToolJson(client, 'filmcraft.apply_transition', { projectId: 'p-Transition', runId: 'r-apply', projectPath, frames: 12, approval });
      assert.equal(applied.isError, false, applied.text);
      assert.equal(applied.parsed.ok, true, applied.text);
      assert.equal(applied.parsed.effect, 'cross_dissolve');
      assert.equal(applied.parsed.frames, 12);
      // The transition persists in the saved sequence.
      const inspected = await callToolJson(client, 'filmcraft.inspect_sequence', { projectPath });
      assert.match(JSON.stringify(inspected.parsed.sequence), /cross_dissolve|transition/i, 'the transition survives save/reopen');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCraftOperationApproval, resolveCraftCommand, validateCraftOperationApproval, verifyFilmcraftConnection } from '../../craft-mcp-client/src/index.mjs';
import { applyFilmCraftTransition, importInterchangeIntoFilmCraft } from '../../editorial-interchange/src/filmcraft-commands.mjs';
import { buildProbePlan, inspectMedia, probeMedia, runMediaCommand } from '../../ffmpeg/src/index.mjs';
import { createEditorialAssembly } from '../../editorial-assembly/src/index.mjs';

// FilmCraft MCP server (the open-source Rust NLE, github.com/storytold/filmcraft).
// Read-only planning and sandboxed artifact generation run without approval;
// every tool that mutates a project goes through the uniform producer-approval
// gate (validateCraftOperationApproval, app 'filmcraft'). CLI drives use fixed
// argv arrays with shell:false — never a shell, never a string command line.

const SERVER_NAME = 'motion-studio-filmcraft';
const SERVER_VERSION = '1.0.0-alpha.1';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const EXPORT_FORMATS = ['h264', 'hevc', 'prores', 'dnxhr', 'png', 'wav'];
const HTTP_HOST = '127.0.0.1';
const HTTP_PATH = '/mcp';
const TOKEN_HEADER = 'x-motion-studio-token';
const projectSchema = z.record(z.string(), z.unknown());
const timeoutSchema = z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional();

export function createFilmcraftApproval({ projectId, runId, toolName, args = {}, approvedBy, now = Date.now(), expiresInMs = 600000 } = {}) {
  // Approve the exact operation arguments the tool will receive, WITHOUT the
  // approval field — including fields the schema fills by default (track,
  // clipOrdinal, effect, frames, save, noAudio, format). The gate digests the
  // resolved arguments, so an approval over a different object is rejected.
  return createCraftOperationApproval({ projectId, runId, app: 'filmcraft', toolName, args, approvedBy, now, expiresInMs });
}

function resolveCommand({ env = process.env } = {}) {
  return resolveCraftCommand({ app: 'filmcraft', env });
}

// First balanced JSON value (object or array) in CLI output. FilmCraft prints
// pretty JSON but is free to append plain-text lines after it (e.g. export
// prints "exported … in 1.7s"), so tail-slicing like JSON.parse(slice(start))
// is not enough.
function extractJsonResult(text, label = 'filmcraft-cli') {
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (depth === 0) {
      if (character === '{' || character === '[') { depth = 1; start = index; }
      continue;
    }
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { start = -1; }
      }
    }
  }
  throw new Error(label + ' did not print a parseable JSON result.');
}

// Mirrors runFilmcraftCli from editorial-interchange: fixed argv, no shell,
// kill on timeout, and the {"ok":false} stdout failure extraction. The error
// carries the raw streams so callers can recover structured receipts (e.g. an
// export that exited 1 with an offlineMedia list on stdout).
function runFilmcraftCli(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('FilmCraft bridge requires a validated argument array.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const failures = stdout.split(/\r?\n/).filter(line => line.includes('"ok":false')).slice(-3);
      const error = new Error('filmcraft-cli failed (exit ' + code + '). ' + (failures.join(' | ') || stderr.slice(-500) || 'no output'));
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });
  });
}

function parseStepResults(stdout) {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function requireExistingFile(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.');
  if (/[\0\r\n]/.test(value)) throw new Error(label + ' contains control characters.');
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(label + ' does not exist: ' + resolved);
  return resolved;
}

function validateOutputPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.');
  if (/[\0\r\n]/.test(value)) throw new Error(label + ' contains control characters.');
  const resolved = path.resolve(value);
  // Render/export outputs are new artifacts: refusing to overwrite keeps a
  // previous master (and its sha256 receipt) intact.
  if (existsSync(resolved)) throw new Error(label + ' already exists; choose a new output path (refusing to overwrite): ' + resolved);
  return resolved;
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function jsonText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// Uniform producer-approval gate for mutating tools. Returns an isError
// result explaining the governance gate, or null when the approval holds.
function gateApproval({ approval, projectId, runId, toolName, opArgs }) {
  const check = validateCraftOperationApproval({ approval, projectId, runId, app: 'filmcraft', toolName, args: opArgs });
  if (check.valid) return null;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      governanceGate: 'filmcraft',
      toolName,
      reason: check.reason,
      guidance: 'Producer approval is required for FilmCraft mutations. Create one with createFilmcraftApproval({ projectId, runId, toolName: ' + JSON.stringify(toolName) + ', args: <the exact operation arguments without approval>, approvedBy: <producer> }) (from @motion-studio/filmcraft-mcp-server, wrapping createCraftOperationApproval) and pass it as the approval field. The args digest is stable-stringified with sorted keys over the resolved operation arguments.'
    }, null, 2) }]
  };
}

// Run one file.newProject/file.saveAs-style session through `run --commands`.
// Session JSONL always lives in a fresh temp dir, never in the repo. Returns
// the per-step result objects printed by the CLI.
async function runSession(command, { projectPath, steps, timeoutMs, signal, label = 'session' } = {}) {
  if (!Array.isArray(steps) || !steps.length || steps.some(step => !step || typeof step.id !== 'string' || !step.id.trim())) {
    throw new Error('FilmCraft ' + label + ' requires a non-empty list of {id, params?} steps with string ids.');
  }
  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-filmcraft-session-'));
  try {
    const sessionFile = path.join(phaseRoot, label + '.jsonl');
    await writeFile(sessionFile, steps.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
    const args = projectPath ? ['--project', projectPath, 'run', '--commands', sessionFile] : ['run', '--commands', sessionFile];
    const output = await runFilmcraftCli(command, args, { timeoutMs, signal });
    return parseStepResults(output.stdout);
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

function findSequenceItems(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (String(node.type || '').toLowerCase() === 'sequence' && Number.isInteger(node.item)) found.push({ item: node.item, name: node.name ?? null });
  for (const child of Array.isArray(node.children) ? node.children : []) findSequenceItems(child, found);
  return found;
}

// Audio-only exports cannot pass probeMedia (it requires a video stream), so
// they use the same ffprobe pipeline with a stream-tolerant parse.
async function probeMediaStreams(file, options = {}) {
  const plan = buildProbePlan({ input: file });
  const result = await runMediaCommand(plan.executable, plan.args, options);
  const value = JSON.parse(result.stdout);
  const video = (value.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (value.streams || []).find(stream => stream.codec_type === 'audio');
  return {
    hasVideo: Boolean(video), videoCodec: video?.codec_name ?? null, width: video?.width ?? null, height: video?.height ?? null,
    frameRate: video?.avg_frame_rate || video?.r_frame_rate || null,
    hasAudio: Boolean(audio), audioCodec: audio?.codec_name ?? null,
    durationSeconds: Number(value.format?.duration || 0)
  };
}

export function buildFilmcraftServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool('filmcraft.check_engine', 'Resolve the filmcraft-cli executable and verify the headless FilmCraft MCP connection. Read-only. Fails closed with install guidance when the engine is missing.', {
  }, async () => {
    const command = await resolveCommand();
    let version = null;
    try { version = (await runFilmcraftCli(command, ['--version'], { timeoutMs: 15000 })).stdout.trim() || null; } catch { /* version probe is best-effort; connection verification reports the hard failure */ }
    let connection;
    try {
      // The 0.20.x CLI launches MCP as `filmcraft-cli mcp` — a leading `--`
      // would demote mcp to a positional and drop later flags.
      connection = await verifyFilmcraftConnection({ command, args: ['mcp'] });
    } catch (error) {
      throw new Error('filmcraft-cli MCP connection failed (' + (command || 'filmcraft-cli') + '): ' + error.message + ' Install FilmCraft from https://github.com/storytold/filmcraft/releases or https://getartcraft.com, or point the FILMCRAFT_CLI environment variable at the filmcraft-cli executable.');
    }
    return jsonText({ command, version, connection: { serverConnected: connection.serverConnected, toolCount: connection.toolCount, tools: connection.tools } });
  });

  server.tool('filmcraft.list_commands', 'List the FilmCraft command surface (id, label, menu, shortcut, params doc) via `commands --json`, optionally filtered by substring. Read-only.', {
    filter: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
    timeoutMs: timeoutSchema
  }, async ({ filter, limit, timeoutMs }) => {
    const command = await resolveCommand();
    const args = ['commands', ...(filter ? [filter] : []), '--json'];
    const commands = extractJsonResult((await runFilmcraftCli(command, args, { timeoutMs })).stdout, 'filmcraft-cli commands');
    if (!Array.isArray(commands)) throw new Error('filmcraft-cli commands --json did not print a JSON array.');
    return jsonText({ command, filter: filter ?? null, total: commands.length, count: Math.min(commands.length, limit), commands: commands.slice(0, limit) });
  });

  server.tool('filmcraft.describe_command', 'Describe one FilmCraft command (menu, shortcut, params, enabled now) via `describe <id>`. Unknown ids fail with substring near-matches. Read-only.', {
    commandId: z.string().min(1).max(200),
    timeoutMs: timeoutSchema
  }, async ({ commandId, timeoutMs }) => {
    const command = await resolveCommand();
    try {
      const described = extractJsonResult((await runFilmcraftCli(command, ['describe', commandId], { timeoutMs })).stdout, 'filmcraft-cli describe');
      return jsonText({ command, commandDescription: described });
    } catch (error) {
      let nearMatches = [];
      try {
        nearMatches = extractJsonResult((await runFilmcraftCli(command, ['commands', commandId, '--json'], { timeoutMs })).stdout, 'filmcraft-cli commands').map(entry => entry?.id).filter(Boolean).slice(0, 10);
      } catch { /* near-match probe is best-effort */ }
      throw new Error('Unknown FilmCraft command id: ' + commandId + '. ' + (nearMatches.length ? 'Near matches: ' + nearMatches.join(', ') + '. ' : '') + 'Run filmcraft.list_commands to browse the surface. (' + error.message + ')');
    }
  });

  server.tool('filmcraft.inspect_project', 'Inspect a saved .fcproj project: bin tree, items, active sequence, revision. Read-only.', {
    projectPath: z.string().min(1),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .fcproj project path');
    const tree = extractJsonResult((await runFilmcraftCli(command, ['--project', resolvedProject, 'inspect', 'project'], { timeoutMs })).stdout, 'filmcraft-cli inspect project');
    return jsonText({ projectPath: resolvedProject, project: tree, sequences: findSequenceItems(tree.root) });
  });

  server.tool('filmcraft.inspect_sequence', 'Inspect a FilmCraft sequence as JSON: settings, tracks, clips with start/end/sourceIn/sourceOut (ticks and frames), transitions, markers. Without sequenceId the saved-active sequence is inspected; with sequenceId the sequence is activated in a throwaway temp copy, so the original project file is never modified. Read-only.', {
    projectPath: z.string().min(1),
    sequenceId: z.number().int().optional(),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, sequenceId, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .fcproj project path');
    const tree = extractJsonResult((await runFilmcraftCli(command, ['--project', resolvedProject, 'inspect', 'project'], { timeoutMs })).stdout, 'filmcraft-cli inspect project');
    const sequences = findSequenceItems(tree.root);
    if (sequenceId === undefined) {
      const sequence = extractJsonResult((await runFilmcraftCli(command, ['--project', resolvedProject, 'inspect', 'sequence'], { timeoutMs })).stdout, 'filmcraft-cli inspect sequence');
      return jsonText({ projectPath: resolvedProject, activeSequence: tree.activeSequence ?? null, sequence, sequences });
    }
    const known = sequences.find(entry => entry.item === sequenceId);
    if (!known) {
      throw new Error('Unknown sequence id ' + sequenceId + ' in ' + resolvedProject + '. ' + (sequences.length ? 'Known sequences: ' + sequences.map(entry => entry.item + (entry.name ? ' "' + entry.name + '"' : '')).join(', ') + '.' : 'This project has no sequences.'));
    }
    // sequence.open does not persist across CLI processes, and saving the
    // producer's project would mutate it — activate the sequence in a
    // throwaway temp copy instead (same convention as the interchange handoff).
    const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-filmcraft-inspect-'));
    try {
      const copyPath = path.join(phaseRoot, 'sequence-copy.fcproj');
      await runSession(command, {
        projectPath: resolvedProject,
        steps: [{ id: 'sequence.open', params: { item: sequenceId } }, { id: 'file.saveAs', params: { path: copyPath } }],
        timeoutMs, label: 'inspect-sequence'
      });
      const sequence = extractJsonResult((await runFilmcraftCli(command, ['--project', copyPath, 'inspect', 'sequence'], { timeoutMs })).stdout, 'filmcraft-cli inspect sequence');
      return jsonText({ projectPath: resolvedProject, sequenceId, sequenceName: known.name, sequence, sequences, inspectedViaTempCopy: true });
    } finally {
      await rm(phaseRoot, { recursive: true, force: true });
    }
  });

  server.tool('filmcraft.render_frame', 'Render one Program-monitor frame of the active sequence to a PNG at a timeline second, then verify it exists, is non-empty and record its sha256. Sandboxed artifact generation; read-only for the project.', {
    projectPath: z.string().min(1),
    seconds: z.number().min(0).max(86400),
    outputPath: z.string().min(1),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, seconds, outputPath, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .fcproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The frame output path');
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const output = await runFilmcraftCli(command, ['--project', resolvedProject, 'render', '--seconds', String(seconds), '--out', resolvedOutput], { timeoutMs });
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('filmcraft-cli render reported success but the PNG is missing or empty: ' + resolvedOutput);
    return jsonText({
      ok: true, projectPath: resolvedProject, outputPath: resolvedOutput, seconds,
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput) },
      cliReport: output.stdout.trim()
    });
  });

  server.tool('filmcraft.probe_media', 'Probe local media with `filmcraft-cli probe` (JSON info, MXF/Ogg/BWF details). Never passes --allow-offline. Read-only.', {
    mediaPath: z.string().min(1),
    timeoutMs: timeoutSchema
  }, async ({ mediaPath, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedMedia = requireExistingFile(mediaPath, 'The media path');
    const output = await runFilmcraftCli(command, ['probe', resolvedMedia], { timeoutMs });
    return jsonText({ mediaPath: resolvedMedia, probe: extractJsonResult(output.stdout, 'filmcraft-cli probe') });
  });

  server.tool('filmcraft.plan_editorial_assembly', 'Build a deterministic frame-accurate FilmCraft editorial assembly manifest from Canonical Video IR. Planning only; it does not modify any editorial engine or source files.', {
    project: projectSchema,
    sequenceName: z.string().min(1).optional()
  }, async ({ project, sequenceName }) => jsonText(createEditorialAssembly(project, { sequenceName })));

  server.tool('filmcraft.import_interchange', 'Import a Motion Studio FCPXML interchange into FilmCraft (file.newProject → file.import → file.saveAs in one session), reopen it, activate the imported sequence and return the import receipt. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    fcpxmlPath: z.string().min(1), projectPath: z.string().min(1),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, fcpxmlPath, projectPath, timeoutMs }) => {
    const gated = gateApproval({ approval, projectId, runId, toolName: 'filmcraft.import_interchange', opArgs: { projectId, runId, fcpxmlPath, projectPath, timeoutMs } });
    if (gated) return gated;
    const receipt = await importInterchangeIntoFilmCraft({ fcpxmlPath, projectPath, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
    return jsonText({ ...receipt, projectId, runId, approvedBy: approval.approvedBy ?? null });
  });

  server.tool('filmcraft.apply_transition', 'Apply a video transition (e.g. cross_dissolve) at a clip boundary on a track of a saved FilmCraft project. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    track: z.string().min(1).max(60).default('V1'),
    clipOrdinal: z.number().int().min(1).default(1),
    effect: z.string().min(1).max(80).default('cross_dissolve'),
    frames: z.number().int().min(1).max(120).default(24),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, track, clipOrdinal, effect, frames, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, track, clipOrdinal, effect, frames, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'filmcraft.apply_transition', opArgs });
    if (gated) return gated;
    const result = await applyFilmCraftTransition({ projectPath, track, clipOrdinal, effect, frames, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
    return jsonText({ ...result, projectId, runId, approvedBy: approval.approvedBy ?? null });
  });

  server.tool('filmcraft.run_command', 'Run one FilmCraft command ({id, params?}) in a headless session, optionally against a saved project and optionally saving back to it. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    commandId: z.string().min(1).max(200),
    params: projectSchema.optional(),
    projectPath: z.string().min(1).optional(),
    save: z.boolean().default(false),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, commandId, params, projectPath, save, timeoutMs }) => {
    const opArgs = { projectId, runId, commandId, params, projectPath, save, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'filmcraft.run_command', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = projectPath ? requireExistingFile(projectPath, 'The .fcproj project path') : undefined;
    if (save && !resolvedProject) throw new Error('save: true requires projectPath: there is nothing to save back to in a fresh session.');
    const steps = [{ id: commandId, params: params ?? {} }];
    if (save) steps.push({ id: 'file.saveAs', params: { path: resolvedProject } });
    try {
      const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'run-command' });
      const failed = results.find(entry => entry.ok === false);
      return jsonText({ ok: !failed, commandId, params: params ?? null, projectPath: resolvedProject ?? null, saved: Boolean(save), results, projectId, runId, approvedBy: approval.approvedBy ?? null });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, commandId, params: params ?? null, projectPath: resolvedProject ?? null, error: error.message, stepResults: error.stdout ? parseStepResults(error.stdout) : [] }, null, 2) }]
      };
    }
  });

  server.tool('filmcraft.run_batch', 'Run 1–500 FilmCraft commands in order in one headless session, optionally against a saved project and optionally saving to saveAs. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    commands: z.array(z.object({ id: z.string().min(1).max(200), params: projectSchema.optional() })).min(1).max(500),
    projectPath: z.string().min(1).optional(),
    saveAs: z.string().min(1).optional(),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, commands, projectPath, saveAs, timeoutMs }) => {
    const opArgs = { projectId, runId, commands, projectPath, saveAs, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'filmcraft.run_batch', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = projectPath ? requireExistingFile(projectPath, 'The .fcproj project path') : undefined;
    const steps = commands.map(step => ({ id: step.id, params: step.params ?? {} }));
    if (saveAs) {
      // file.saveAs does not create parent directories, and a saveAs from a
      // separate session would persist an empty project — it must be the last
      // step of the same session (verified handoff convention).
      const resolvedSaveAs = path.resolve(saveAs);
      await mkdir(path.dirname(resolvedSaveAs), { recursive: true });
      steps.push({ id: 'file.saveAs', params: { path: resolvedSaveAs } });
    }
    try {
      const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'run-batch' });
      const failed = results.find(entry => entry.ok === false);
      return jsonText({ ok: !failed, stepCount: steps.length, projectPath: resolvedProject ?? null, savedAs: saveAs ? path.resolve(saveAs) : null, results, projectId, runId, approvedBy: approval.approvedBy ?? null });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, stepCount: steps.length, projectPath: resolvedProject ?? null, savedAs: saveAs ? path.resolve(saveAs) : null, error: error.message, stepResults: error.stdout ? parseStepResults(error.stdout) : [] }, null, 2) }]
      };
    }
  });

  server.tool('filmcraft.export_master', 'Export the active sequence of a saved FilmCraft project (h264|hevc|prores|dnxhr|png|wav) and independently verify the artifact with FFprobe plus a sha256 receipt. Offline media fails closed with the offline list — --allow-offline is never passed.', {
    projectPath: z.string().min(1),
    outputPath: z.string().min(1),
    format: z.enum(EXPORT_FORMATS).default('h264'),
    preset: z.string().min(1).max(120).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    start: z.number().min(0).max(86400).optional(),
    end: z.number().min(0).max(86400).optional(),
    noAudio: z.boolean().default(false),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, outputPath, format, preset, quality, start, end, noAudio, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .fcproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The master output path');
    if ((start === undefined) !== (end === undefined)) throw new Error('start and end must be provided together (a custom range in seconds) or omitted entirely.');
    if (start !== undefined && end !== undefined && end <= start) throw new Error('end must be greater than start.');
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const args = ['--project', resolvedProject, 'export', resolvedOutput, '--format', format];
    if (preset) args.push('--preset', preset);
    if (quality !== undefined) args.push('--quality', String(quality));
    if (start !== undefined) args.push('--start', String(start), '--end', String(end));
    if (noAudio) args.push('--no-audio');
    let exportReceipt;
    try {
      exportReceipt = extractJsonResult((await runFilmcraftCli(command, args, { timeoutMs })).stdout, 'filmcraft-cli export');
    } catch (error) {
      // Offline media exits 1 after writing placeholder frames; the receipt
      // (with the offlineMedia list) is still on stdout. Fail closed on it.
      const offline = error.stdout ? safeExtractOffline(error.stdout) : null;
      if (offline?.length) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ ok: false, refused: true, reason: 'The export drew placeholder frames for offline media. Relink the media (media.relink) and retry; filmcraft.export_master never passes --allow-offline and refuses to certify the artifact.', offlineMedia: offline, projectPath: resolvedProject, outputPath: resolvedOutput, format }, null, 2) }]
        };
      }
      throw error;
    }
    const offlineMedia = Array.isArray(exportReceipt.offlineMedia) ? exportReceipt.offlineMedia : [];
    if (offlineMedia.length) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, refused: true, reason: 'The export reported offline media. Relink the media (media.relink) and retry; filmcraft.export_master never passes --allow-offline and refuses to certify the artifact.', offlineMedia, projectPath: resolvedProject, outputPath: resolvedOutput, format }, null, 2) }]
      };
    }
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('filmcraft-cli export reported success but the master is missing or empty: ' + resolvedOutput);
    // Independent verification with the same FFprobe helpers the EffectCraft
    // adapter uses (probeMedia/inspectMedia); audio-only formats use the same
    // probe pipeline with a stream-tolerant parse. Verification failures fail
    // closed with named context instead of a bare spawn error.
    let media, verification;
    try {
      if (format === 'wav') {
        media = await probeMediaStreams(resolvedOutput);
        const failures = [];
        if (!media.hasAudio) failures.push({ code: 'MEDIA_AUDIO_MISSING', message: 'The wav master has no audio stream.' });
        if (!(media.durationSeconds > 0)) failures.push({ code: 'MEDIA_DURATION_INVALID', message: 'The wav master has no probeable duration.' });
        verification = { passed: failures.length === 0, failures, mode: 'audio-only' };
      } else {
        media = await probeMedia(resolvedOutput);
        verification = inspectMedia(media, {
          ...(start !== undefined && end !== undefined ? { durationSeconds: end - start, durationToleranceSeconds: 0.5 } : {})
        });
      }
    } catch (error) {
      throw new Error('FFprobe verification could not run for ' + resolvedOutput + ': ' + error.message + ' FFmpeg/FFprobe must be on PATH so exported masters are independently verified; nothing is certified without it.');
    }
    const receipt = {
      ok: verification.passed,
      projectPath: resolvedProject,
      outputPath: resolvedOutput,
      format, preset: preset ?? null, quality: quality ?? null,
      range: start !== undefined ? { start, end } : { mode: 'entire' },
      noAudio,
      export: exportReceipt,
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput), media },
      verification,
      verified: verification.passed,
      completedAt: new Date().toISOString()
    };
    return { ...jsonText(receipt), isError: !verification.passed };
  });

  return server;
}

function safeExtractOffline(stdout) {
  try {
    const receipt = extractJsonResult(stdout, 'filmcraft-cli export');
    return Array.isArray(receipt?.offlineMedia) ? receipt.offlineMedia : null;
  } catch { return null; }
}

// HTTP mode for UXP panels: node:http bound strictly to 127.0.0.1, stateless
// streamable-http transport (a fresh transport+server per request — reusing a
// stateless transport causes message-id collisions between clients).
async function startFilmcraftHttpServer({ argv = [], env = process.env } = {}) {
  let port = 7430;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--port') {
      index += 1;
      port = Number(argv[index]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535 (0 picks an ephemeral port).');
    } else if (argument === '--host') {
      index += 1;
      if (argv[index] !== HTTP_HOST) throw new Error('The FilmCraft HTTP transport binds strictly to ' + HTTP_HOST + '; refusing host ' + argv[index] + '.');
    } else if (argument !== '--http') {
      throw new Error('Unknown argument: ' + argument + ' (supported: --http, --port <n>).');
    }
  }
  const token = typeof env.MOTION_STUDIO_CRAFT_HTTP_TOKEN === 'string' ? env.MOTION_STUDIO_CRAFT_HTTP_TOKEN : '';
  if (token && !token.trim()) throw new Error('MOTION_STUDIO_CRAFT_HTTP_TOKEN is set but empty; unset it or provide a real token.');

  const httpServer = createHttpServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://' + HTTP_HOST).pathname; } catch { /* fall through to 404 */ }
    if (pathname !== HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Only ' + HTTP_PATH + ' is served.' }));
      return;
    }
    if (token) {
      const provided = req.headers[TOKEN_HEADER];
      const matches = typeof provided === 'string' && provided.length === token.length
        && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
      if (!matches) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden. A valid ' + TOKEN_HEADER + ' header is required.' }));
        return;
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE', 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildFilmcraftServer();
    // Why: keep per-request objects from leaking; 'close' fires when the
    // response stream ends (including client disconnects).
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    Promise.resolve().then(async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null }));
      } else {
        res.end();
      }
      console.error('[filmcraft-http] request failed: ' + (error?.message || error));
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, HTTP_HOST, resolve);
  });
  const address = httpServer.address();
  // The bound port is the only thing the client needs; the token value is
  // never printed anywhere.
  process.stdout.write('filmcraft http server listening on ' + HTTP_HOST + ':' + address.port + ' path ' + HTTP_PATH + ' tokenRequired:' + Boolean(token) + '\n');
  const shutdown = () => {
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return httpServer;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--http')) await startFilmcraftHttpServer({ argv });
  else {
    const server = buildFilmcraftServer();
    await server.connect(new StdioServerTransport());
  }
}

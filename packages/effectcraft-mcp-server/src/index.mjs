import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCraftOperationApproval, resolveCraftCommand, validateCraftOperationApproval, verifyEffectCraftConnection } from '../../craft-mcp-client/src/index.mjs';
import { parseJsonObjects, planEffectCraftScene, renderEffectCraftScene } from '../../effectcraft-adapter/src/index.mjs';
import { inspectMedia, probeMedia } from '../../ffmpeg/src/index.mjs';
import { validateProject } from '../../core/src/index.mjs';

// EffectCraft MCP server (the open-source Rust compositing engine,
// github.com/storytold/effectcraft). Read-only planning and sandboxed
// artifact generation run without approval; every tool that mutates engine
// state goes through the uniform producer-approval gate
// (validateCraftOperationApproval, app 'effectcraft'). CLI drives use fixed
// argv arrays with shell:false — never a shell, never a string command line.
// The CLI surface verified live on 0.24.1: `commands [--filter] [--enabled]
// --json`, `info`, `get`, `props`, `run --commands`, `render-frame`,
// `render`, `mcp`, plus the mask/marker/work-area/blend/matte/parent,
// renderQueue, text.fonts and Lottie/timeline interchange commands (all
// probed headless; renderQueue.add/file.exportLottie/file.exportTimeline
// honor their comp param in reopened sessions without comp.open). There is
// deliberately no `export` subcommand (that is FilmCraft) and prop.set does
// not take expressions — the adapter plans prop.setExpression steps instead.

const SERVER_NAME = 'motion-studio-effectcraft';
const SERVER_VERSION = '1.0.0-alpha.1';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const RENDER_FORMATS = ['h264', 'hevc', 'av1', 'prores', 'webm'];
const MASK_SHAPES = ['rect', 'ellipse', 'rounded', 'polygon', 'star'];
const TRACK_MATTE_KINDS = ['alpha', 'alphaInverted', 'luma', 'lumaInverted', 'preserve'];
// The blend-mode enum layer.setBlendMode accepts on 0.24.1 (common AE surface;
// values pass through unchanged — the props readback echoes them verbatim).
const BLEND_MODES = [
  'Normal', 'Multiply', 'Screen', 'Overlay', 'Add', 'Lighten', 'Darken', 'ColorDodge', 'ColorBurn',
  'HardLight', 'SoftLight', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity',
  'StencilAlpha', 'StencilLuma', 'SilhouetteAlpha', 'SilhouetteLuma', 'AlphaAdd', 'ClassicColorBurn',
  'ClassicColorDodge', 'LinearBurn', 'LinearDodge', 'LinearLight', 'PinLight', 'VividLight', 'HardMix'
];
const TIMELINE_EXPORT_FORMATS = ['fcpxml', 'xml', 'otio', 'edl'];
const TIMELINE_IMPORT_FORMATS = ['auto', 'fcpxml', 'xml', 'otio', 'edl', 'aaf', 'omf'];
const HTTP_HOST = '127.0.0.1';
const HTTP_PATH = '/mcp';
const TOKEN_HEADER = 'x-motion-studio-token';
const projectSchema = z.record(z.string(), z.unknown());
const timeoutSchema = z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional();
const idPattern = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export function createEffectCraftApproval({ projectId, runId, toolName, args = {}, approvedBy, now = Date.now(), expiresInMs = 600000 } = {}) {
  // Approve the exact operation arguments the tool will receive, WITHOUT the
  // approval field — including fields the schema fills by default. The gate
  // digests the resolved arguments, so an approval over a different object is
  // rejected.
  return createCraftOperationApproval({ projectId, runId, app: 'effectcraft', toolName, args, approvedBy, now, expiresInMs });
}

function resolveCommand({ env = process.env } = {}) {
  return resolveCraftCommand({ app: 'effectcraft', env });
}

// Mirrors runFilmcraftCli / the adapter's execute(): fixed argv, no shell,
// kill on timeout. Both streams ride on the error so callers can recover
// structured output (e.g. step results from a failed session).
function runEffectCraftCli(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('EffectCraft bridge requires a validated argument array.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
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
      const error = new Error('effectcraft-cli failed (exit ' + code + '). stderr: ' + stderr.slice(-800) + ' stdout: ' + stdout.slice(-800));
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });
  });
}

// EffectCraft's `run --json` prints ONE JSON array with per-step attribution:
// [{"command": id, "result": value|null}] — steps that produce no reportable
// result (e.g. file.newProject) come back as result: null but still succeeded
// (the process exit code gates the session). Results are attributed by
// position within the array; the positional brace-depth scanner is only the
// fallback for CLI versions that ignore --json.
function attributeStepResults(steps, stdout) {
  let entries = null;
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) entries = parsed;
  } catch { /* fall through to positional parsing */ }
  if (Array.isArray(entries)) {
    return steps.map((step, index) => {
      const entry = entries[index];
      const result = entry?.result ?? null;
      const failed = Boolean(result) && (result.ok === false || result.error !== undefined);
      return { id: step.id, params: step.params ?? null, ok: Boolean(entry) && !failed, silent: result === null, result };
    });
  }
  const positional = parseJsonObjects(stdout);
  return steps.map((step, index) => {
    const result = positional[index] ?? null;
    const failed = Boolean(result) && (result.ok === false || result.error !== undefined);
    return { id: step.id, params: step.params ?? null, ok: Boolean(result) && !failed, silent: result === null, result };
  });
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
  // Render outputs are new artifacts: refusing to overwrite keeps a previous
  // master (and its sha256 receipt) intact.
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
  const check = validateCraftOperationApproval({ approval, projectId, runId, app: 'effectcraft', toolName, args: opArgs });
  if (check.valid) return null;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      governanceGate: 'effectcraft',
      toolName,
      reason: check.reason,
      guidance: 'Producer approval is required for EffectCraft mutations. Create one with createEffectCraftApproval({ projectId, runId, toolName: ' + JSON.stringify(toolName) + ', args: <the exact operation arguments without approval>, approvedBy: <producer> }) (from @motion-studio/effectcraft-mcp-server, wrapping createCraftOperationApproval) and pass it as the approval field. The args digest is stable-stringified with sorted keys over the resolved operation arguments.'
    }, null, 2) }]
  };
}

// Run one journaled session through `run --commands`. Session JSONL always
// lives in a fresh temp dir, never in the repo; cwd is the temp dir because
// EffectCraft resolves relative paths against the working directory.
async function runSession(command, { projectPath, steps, timeoutMs, signal, label = 'session' } = {}) {
  if (!Array.isArray(steps) || !steps.length || steps.some(step => !step || typeof step.id !== 'string' || !step.id.trim())) {
    throw new Error('EffectCraft ' + label + ' requires a non-empty list of {id, params?} steps with string ids.');
  }
  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-effectcraft-session-'));
  try {
    const sessionFile = path.join(phaseRoot, label + '.jsonl');
    await writeFile(sessionFile, steps.map(step => JSON.stringify({ id: step.id, params: step.params ?? {} })).join('\n') + '\n', 'utf8');
    const args = projectPath ? ['--project', projectPath, 'run', '--commands', sessionFile] : ['run', '--commands', sessionFile];
    args.push('--json');
    const output = await runEffectCraftCli(command, args, { cwd: phaseRoot, timeoutMs, signal });
    return attributeStepResults(steps, output.stdout);
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

// Shared body for the gated single-session mutation tools: one journaled
// session whose LAST step is file.saveAs back into the project; success builds
// a receipt from the attributed step results, failure comes back as a
// structured isError payload with per-step attribution (run_command's shape).
async function runApprovedSession(command, { label, projectPath, steps, timeoutMs, receipt }) {
  let results;
  try {
    results = await runSession(command, { projectPath, steps, timeoutMs, label });
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, projectPath, error: error.message, stepResults: error.stdout ? attributeStepResults(steps, error.stdout) : [] }, null, 2) }]
    };
  }
  const failed = results.find(entry => !entry.ok);
  return jsonText({ ...(await receipt(results)), ok: !failed, results });
}

// Same sandbox the canonical video.* render tools use: project workspaces
// live under <cwd>/projects/<projectId>/ and nothing can escape.
function projectPaths(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('projectId must contain only letters, numbers, underscores or hyphens.');
  const projectsRoot = path.resolve(process.cwd(), 'projects');
  const root = path.resolve(projectsRoot, id);
  const relative = path.relative(projectsRoot, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project path escaped the projects directory.');
  return { root, source: path.join(root, 'project.json'), renders: path.join(root, 'renders') };
}

export function buildEffectCraftServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool('effectcraft.check_engine', 'Resolve the effectcraft-cli executable and verify the headless EffectCraft MCP connection. Read-only. Fails closed with install guidance when the engine is missing.', {
  }, async () => {
    const command = await resolveCommand();
    let version = null;
    try { version = (await runEffectCraftCli(command, ['--version'], { timeoutMs: 15000 })).stdout.trim() || null; } catch { /* version probe is best-effort; connection verification reports the hard failure */ }
    let connection;
    try {
      connection = await verifyEffectCraftConnection({ command, args: ['mcp'] });
    } catch (error) {
      throw new Error('effectcraft-cli MCP connection failed (' + (command || 'effectcraft-cli') + '): ' + error.message + ' Install EffectCraft from https://github.com/storytold/effectcraft/releases or https://getartcraft.com, or point the EFFECTCRAFT_CLI environment variable at the effectcraft-cli executable.');
    }
    return jsonText({ command, version, connection: { serverConnected: connection.serverConnected, toolCount: connection.toolCount, tools: connection.tools } });
  });

  server.tool('effectcraft.list_commands', 'List the EffectCraft command surface (id, label, menu, params doc, shortcut) via `commands --json`, optionally filtered by substring (--filter) or to enabled-only. Read-only.', {
    filter: z.string().min(1).max(200).optional(),
    enabledOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(2000).default(200),
    timeoutMs: timeoutSchema
  }, async ({ filter, enabledOnly, limit, timeoutMs }) => {
    const command = await resolveCommand();
    const args = ['commands'];
    if (filter) args.push('--filter', filter);
    if (enabledOnly) args.push('--enabled');
    args.push('--json');
    const commands = JSON.parse((await runEffectCraftCli(command, args, { timeoutMs })).stdout);
    if (!Array.isArray(commands)) throw new Error('effectcraft-cli commands --json did not print a JSON array.');
    return jsonText({ command, filter: filter ?? null, enabledOnly, total: commands.length, count: Math.min(commands.length, limit), commands: commands.slice(0, limit) });
  });

  server.tool('effectcraft.describe_command', 'Describe one EffectCraft command (menu, params doc, shortcut, enabled) via `commands --filter --json`. Unknown ids fail with substring near-matches. Read-only.', {
    commandId: z.string().min(1).max(200),
    timeoutMs: timeoutSchema
  }, async ({ commandId, timeoutMs }) => {
    const command = await resolveCommand();
    const entries = JSON.parse((await runEffectCraftCli(command, ['commands', '--filter', commandId, '--json'], { timeoutMs })).stdout);
    if (!Array.isArray(entries)) throw new Error('effectcraft-cli commands --json did not print a JSON array.');
    const exact = entries.find(entry => entry?.id === commandId);
    if (exact) return jsonText({ command, commandDescription: exact });
    const nearMatches = entries.map(entry => entry?.id).filter(Boolean).slice(0, 10);
    throw new Error('Unknown EffectCraft command id: ' + commandId + '. ' + (nearMatches.length ? 'Near matches: ' + nearMatches.join(', ') + '. ' : '') + 'Run effectcraft.list_commands to browse the surface.');
  });

  server.tool('effectcraft.inspect_project', 'Inspect a saved .ecproj project via the CLI `info` summary: item tree, comp sizes, active comp and layer stack. Read-only (text summary from the engine).', {
    projectPath: z.string().min(1),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const output = await runEffectCraftCli(command, ['--project', resolvedProject, 'info'], { timeoutMs });
    const lines = output.stdout.trim().split(/\r?\n/);
    return jsonText({ projectPath: resolvedProject, engineLine: lines[0] ?? null, summary: output.stdout.trim() });
  });

  server.tool('effectcraft.get_property', 'Read one layer property value from a saved .ecproj (`get <comp> <layer> <path> --json`): value, keyframes, expression, type. Read-only.', {
    projectPath: z.string().min(1),
    comp: z.string().min(1).max(200),
    layer: z.string().min(1).max(200),
    propertyPath: z.string().min(1).max(300),
    timeSeconds: z.number().min(0).max(86400).optional(),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, comp, layer, propertyPath, timeSeconds, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const args = ['--project', resolvedProject, 'get', comp, layer, propertyPath];
    if (timeSeconds !== undefined) args.push('--time', String(timeSeconds));
    args.push('--json');
    const output = await runEffectCraftCli(command, args, { timeoutMs });
    return jsonText({ projectPath: resolvedProject, comp, layer, propertyPath, timeSeconds: timeSeconds ?? null, property: JSON.parse(output.stdout) });
  });

  server.tool('effectcraft.layer_props', 'Dump a layer property tree from a saved .ecproj (`props <comp> <layer> --json`): every property path, type and value plus switches and blend mode. Read-only.', {
    projectPath: z.string().min(1),
    comp: z.string().min(1).max(200),
    layer: z.string().min(1).max(200),
    flat: z.boolean().default(false),
    timeSeconds: z.number().min(0).max(86400).optional(),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, comp, layer, flat, timeSeconds, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const args = ['--project', resolvedProject, 'props', comp, layer];
    if (flat) args.push('--flat');
    if (timeSeconds !== undefined) args.push('--time', String(timeSeconds));
    args.push('--json');
    const output = await runEffectCraftCli(command, args, { timeoutMs });
    return jsonText({ projectPath: resolvedProject, comp, layer, flat, timeSeconds: timeSeconds ?? null, layerProps: JSON.parse(output.stdout) });
  });

  server.tool('effectcraft.plan_scene', 'Plan an EffectCraft engine-command script from Canonical Video IR (pure planning: comp.new, layer.*, prop.set keyframes, expressions, effects; asset placements are reported as phase-two entries). No engine is launched.', {
    project: projectSchema,
    sceneId: z.string().min(1).max(120)
  }, async ({ project, sceneId }) => {
    const plan = planEffectCraftScene(project, sceneId);
    return jsonText(plan);
  });

  server.tool('effectcraft.render_frame', 'Render one frame of a saved .ecproj comp to a PNG (`render-frame --comp --time/--frame [--transparent] [--max-side]`), then verify it exists, is non-empty and record its sha256. Sandboxed artifact generation; read-only for the project.', {
    projectPath: z.string().min(1),
    compId: z.string().min(1).max(200),
    timeSeconds: z.number().min(0).max(86400).optional(),
    frameNumber: z.number().int().min(0).optional(),
    outputPath: z.string().min(1),
    transparent: z.boolean().default(false),
    maxSide: z.number().int().min(16).max(8192).optional(),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, compId, timeSeconds, frameNumber, outputPath, transparent, maxSide, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The frame output path');
    if (timeSeconds !== undefined && frameNumber !== undefined) throw new Error('Provide timeSeconds or frameNumber, not both.');
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const args = ['--project', resolvedProject, 'render-frame', '--comp', compId];
    args.push(frameNumber !== undefined ? '--frame' : '--time', String(frameNumber !== undefined ? frameNumber : (timeSeconds ?? 0)));
    if (transparent) args.push('--transparent');
    if (maxSide !== undefined) args.push('--max-side', String(maxSide));
    args.push('--out', resolvedOutput);
    await runEffectCraftCli(command, args, { timeoutMs });
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('effectcraft-cli render-frame reported success but the PNG is missing or empty: ' + resolvedOutput);
    return jsonText({
      ok: true, projectPath: resolvedProject, compId, outputPath: resolvedOutput,
      timeSeconds: timeSeconds ?? null, frameNumber: frameNumber ?? null, transparent,
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput) }
    });
  });

  server.tool('effectcraft.render_scene', 'Render an explicitly authored Canonical Video IR scene through the EffectCraft adapter from the stored project workspace: builds scene.ecproj (with checkpoints), renders the comp and independently verifies the artifact with FFprobe. Fail-closed: isError when unverified.', {
    projectId: idPattern,
    sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
  }, async ({ projectId, sceneId }) => {
    const paths = projectPaths(projectId);
    const project = JSON.parse(await readFile(paths.source, 'utf8'));
    const validation = validateProject(project);
    if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
    const scene = project.scenes.find(item => item.id === sceneId);
    if (!scene) throw new Error('Unknown scene id: ' + sceneId);
    const result = await renderEffectCraftScene(project, sceneId, { projectRoot: paths.root });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.verified };
  });

  server.tool('effectcraft.render_comp', 'Render a saved .ecproj comp (' + RENDER_FORMATS.join('|') + ') with the full render flag surface (fps, resolution, quality, channels, bitrate, ProRes profile, range) and independently verify the artifact with FFprobe plus a sha256 receipt. Fail-closed: isError when unverified.', {
    projectPath: z.string().min(1),
    compId: z.string().min(1).max(200),
    outputPath: z.string().min(1),
    format: z.enum(RENDER_FORMATS).default('h264'),
    fps: z.number().positive().max(240).optional(),
    resolution: z.enum(['full', 'half', 'third', 'quarter']).optional(),
    quality: z.enum(['best', 'draft']).optional(),
    channels: z.enum(['rgb', 'rgba']).optional(),
    bitrate: z.number().int().min(100).max(1_000_000).optional(),
    proresProfile: z.enum(['proxy', 'lt', 'standard', 'hq', '4444', '4444xq']).optional(),
    start: z.number().min(0).max(86400).optional(),
    end: z.number().min(0).max(86400).optional(),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, compId, outputPath, format, fps, resolution, quality, channels, bitrate, proresProfile, start, end, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The render output path');
    if ((start === undefined) !== (end === undefined)) throw new Error('start and end must be provided together (a custom range in seconds) or omitted entirely.');
    if (start !== undefined && end !== undefined && end <= start) throw new Error('end must be greater than start.');
    if (format === 'prores' && !channels) throw new Error('prores requires channels rgba (4444 profiles are RGB+alpha); pass channels: "rgba".');
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const args = ['--project', resolvedProject, 'render', '--comp', compId, '--out', resolvedOutput, '--format', format];
    if (fps !== undefined) args.push('--fps', String(fps));
    if (resolution) args.push('--resolution', resolution);
    if (quality) args.push('--quality', quality);
    if (channels) args.push('--channels', channels);
    if (bitrate !== undefined) args.push('--bitrate', String(bitrate));
    if (proresProfile) args.push('--prores', proresProfile);
    if (start !== undefined) args.push('--start', String(start), '--end', String(end));
    await runEffectCraftCli(command, args, { timeoutMs });
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('effectcraft-cli render reported success but the artifact is missing or empty: ' + resolvedOutput);
    let media, verification;
    try {
      media = await probeMedia(resolvedOutput);
    } catch (error) {
      throw new Error('FFprobe verification could not run for ' + resolvedOutput + ': ' + error.message + ' FFmpeg/FFprobe must be on PATH so rendered artifacts are independently verified; nothing is certified without it.');
    }
    const failures = [];
    // probeMedia reports codec/dimensions rather than a hasVideo flag; a video
    // render must have both.
    if (!media.videoCodec || !(media.width > 0) || !(media.height > 0)) failures.push({ code: 'MEDIA_VIDEO_MISSING', message: 'The render has no probeable video stream (codec + dimensions).' });
    if (!(media.width > 0) || !(media.height > 0)) failures.push({ code: 'MEDIA_DIMENSIONS_INVALID', message: 'The render has no probeable dimensions.' });
    if (!(media.durationSeconds > 0)) failures.push({ code: 'MEDIA_DURATION_INVALID', message: 'The render has no probeable duration.' });
    let inspected = null;
    try {
      inspected = inspectMedia(media, {
        ...(fps !== undefined ? { fps } : {}),
        ...(start !== undefined && end !== undefined ? { durationSeconds: end - start, durationToleranceSeconds: 0.5 } : {})
      });
      failures.push(...inspected.failures);
    } catch { /* inspectMedia without a contract is optional; the manual checks above still gate */ }
    verification = { passed: failures.length === 0, failures, inspected: inspected ? { passed: inspected.passed } : null };
    const receipt = {
      ok: verification.passed,
      projectPath: resolvedProject,
      compId,
      outputPath: resolvedOutput,
      format, fps: fps ?? null, resolution: resolution ?? null, quality: quality ?? null, channels: channels ?? null,
      bitrate: bitrate ?? null, proresProfile: proresProfile ?? null,
      range: start !== undefined ? { start, end } : { mode: 'comp' },
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput), media },
      verification,
      verified: verification.passed,
      completedAt: new Date().toISOString()
    };
    return { ...jsonText(receipt), isError: !verification.passed };
  });

  server.tool('effectcraft.run_command', 'Run one EffectCraft engine command ({id, params?}) in a headless session, optionally against a saved project and optionally saving back to it. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    commandId: z.string().min(1).max(200),
    params: projectSchema.optional(),
    projectPath: z.string().min(1).optional(),
    save: z.boolean().default(false),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, commandId, params, projectPath, save, timeoutMs }) => {
    const opArgs = { projectId, runId, commandId, params, projectPath, save, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.run_command', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = projectPath ? requireExistingFile(projectPath, 'The .ecproj project path') : undefined;
    if (save && !resolvedProject) throw new Error('save: true requires projectPath: there is nothing to save back to in a fresh session.');
    const steps = [{ id: commandId, params: params ?? {} }];
    if (save) steps.push({ id: 'file.saveAs', params: { path: resolvedProject } });
    try {
      const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'run-command' });
      const failed = results.find(entry => !entry.ok);
      return jsonText({ ok: !failed, commandId, params: params ?? null, projectPath: resolvedProject ?? null, saved: Boolean(save), results, projectId, runId, approvedBy: approval.approvedBy ?? null });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, commandId, params: params ?? null, projectPath: resolvedProject ?? null, error: error.message, stepResults: error.stdout ? attributeStepResults(steps, error.stdout) : [] }, null, 2) }]
      };
    }
  });

  server.tool('effectcraft.run_batch', 'Run 1–500 EffectCraft engine commands in order in one headless session, optionally against a saved project and optionally saving to saveAs (file.saveAs must be the last step of the same session — a save from a separate session persists an empty project). Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    commands: z.array(z.object({ id: z.string().min(1).max(200), params: projectSchema.optional() })).min(1).max(500),
    projectPath: z.string().min(1).optional(),
    saveAs: z.string().min(1).optional(),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, commands, projectPath, saveAs, timeoutMs }) => {
    const opArgs = { projectId, runId, commands, projectPath, saveAs, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.run_batch', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = projectPath ? requireExistingFile(projectPath, 'The .ecproj project path') : undefined;
    const steps = commands.map(step => ({ id: step.id, params: step.params ?? {} }));
    if (saveAs) {
      // file.saveAs does not create parent directories, and a saveAs from a
      // separate session would persist an empty project — it must be the last
      // step of the same session (verified adapter convention).
      const resolvedSaveAs = path.resolve(saveAs);
      await mkdir(path.dirname(resolvedSaveAs), { recursive: true });
      steps.push({ id: 'file.saveAs', params: { path: resolvedSaveAs } });
    }
    try {
      const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'run-batch' });
      const failed = results.find(entry => !entry.ok);
      return jsonText({ ok: !failed, stepCount: steps.length, projectPath: resolvedProject ?? null, savedAs: saveAs ? path.resolve(saveAs) : null, results, projectId, runId, approvedBy: approval.approvedBy ?? null });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, stepCount: steps.length, projectPath: resolvedProject ?? null, savedAs: saveAs ? path.resolve(saveAs) : null, error: error.message, stepResults: error.stdout ? attributeStepResults(steps, error.stdout) : [] }, null, 2) }]
      };
    }
  });

  server.tool('effectcraft.add_mask', 'Add a mask to one layer of a saved .ecproj comp — layer.addMask (rect/ellipse/rounded/polygon/star) or mask.new from 3–200 vertices — then save the project back. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    layer: z.string().min(1),
    shape: z.enum(MASK_SHAPES),
    rect: z.array(z.number()).length(4).optional(),
    roundness: z.number().min(0).optional(),
    vertices: z.array(z.array(z.number()).length(2)).min(3).max(200).optional(),
    mode: z.string().max(40).optional(),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, layer, shape, rect, roundness, vertices, mode, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, layer, shape, rect, roundness, vertices, mode, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.add_mask', opArgs });
    if (gated) return gated;
    if (Boolean(rect) === Boolean(vertices)) throw new Error('Provide exactly one of rect (layer space [x, y, w, h] for the layer.addMask shapes) or vertices (the mask.new path).');
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const maskStep = rect !== undefined
      ? { id: 'layer.addMask', params: { layer, shape, rect, ...(roundness !== undefined ? { roundness } : {}), ...(mode !== undefined ? { mode } : {}) } }
      : { id: 'mask.new', params: { layer, vertices, closed: true, ...(mode !== undefined ? { mode } : {}) } };
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      maskStep,
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'add-mask', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async results => ({
        projectId, runId, approvedBy: approval.approvedBy ?? null,
        projectPath: resolvedProject, compId, layer, shape,
        path: rect !== undefined ? 'layer.addMask' : 'mask.new',
        mask: results[1]?.result?.mask ?? null,
        savePath: resolvedProject
      })
    });
  });

  server.tool('effectcraft.set_track_matte', 'Set the track matte of one layer in a saved .ecproj comp (layer.setTrackMatte with a matte layer and an alpha/luma kind), then save the project back. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    layer: z.string().min(1),
    matteLayer: z.string().min(1),
    kind: z.enum(TRACK_MATTE_KINDS).default('alpha'),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, layer, matteLayer, kind, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, layer, matteLayer, kind, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.set_track_matte', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      { id: 'layer.setTrackMatte', params: { layer, matte: matteLayer, kind } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'track-matte', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async () => ({
        projectId, runId, approvedBy: approval.approvedBy ?? null,
        projectPath: resolvedProject, compId, layer, matteLayer, kind, savePath: resolvedProject
      })
    });
  });

  server.tool('effectcraft.set_blend_mode', 'Set the blend mode of one layer in a saved .ecproj comp (layer.setBlendMode), save the project back and re-read the layer props to verify the mode. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    layer: z.string().min(1),
    mode: z.enum(BLEND_MODES),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, layer, mode, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, layer, mode, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.set_blend_mode', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      { id: 'layer.setBlendMode', params: { layer, mode } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'blend-mode', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async () => {
        const propsOutput = await runEffectCraftCli(command, ['--project', resolvedProject, 'props', compId, layer, '--json'], { timeoutMs });
        const blendMode = JSON.parse(propsOutput.stdout)?.blendMode ?? null;
        return {
          projectId, runId, approvedBy: approval.approvedBy ?? null,
          projectPath: resolvedProject, compId, layer, mode,
          verified: { blendMode, expected: mode, matches: blendMode === mode },
          savePath: resolvedProject
        };
      }
    });
  });

  server.tool('effectcraft.set_parent', 'Parent one layer of a saved .ecproj comp to another layer (layer.setParent, optionally compensating for the transform), then save the project back. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    layer: z.string().min(1),
    parentLayer: z.string().min(1),
    compensate: z.boolean().default(false),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, layer, parentLayer, compensate, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, layer, parentLayer, compensate, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.set_parent', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      { id: 'layer.setParent', params: { layer, parent: parentLayer, compensate } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'set-parent', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async () => ({
        projectId, runId, approvedBy: approval.approvedBy ?? null,
        projectPath: resolvedProject, compId, layer, parentLayer, compensate, savePath: resolvedProject
      })
    });
  });

  server.tool('effectcraft.add_marker', 'Add a composition marker at a time in seconds to a saved .ecproj comp (comp.addMarker), then save the project back. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    seconds: z.number().min(0).max(86400),
    comment: z.string().max(500).optional(),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, seconds, comment, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, seconds, comment, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.add_marker', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      { id: 'comp.addMarker', params: { time: seconds, ...(comment !== undefined ? { comment } : {}) } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'add-marker', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async results => ({
        projectId, runId, approvedBy: approval.approvedBy ?? null,
        projectPath: resolvedProject, compId,
        seconds, comment: comment ?? null,
        marker: results[1]?.result ?? null,
        savePath: resolvedProject
      })
    });
  });

  server.tool('effectcraft.set_work_area', 'Set the work area of a saved .ecproj comp (comp.workArea, start/end in seconds), then save the project back. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    start: z.number().min(0),
    end: z.number().min(0),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, compId, start, end, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, compId, start, end, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.set_work_area', opArgs });
    if (gated) return gated;
    if (end <= start) throw new Error('end must be greater than start.');
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const steps = [
      { id: 'comp.open', params: { comp: compId } },
      { id: 'comp.workArea', params: { start, end } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'work-area', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async results => ({
        projectId, runId, approvedBy: approval.approvedBy ?? null,
        projectPath: resolvedProject, compId, start, end,
        workArea: results[1]?.result ?? null,
        savePath: resolvedProject
      })
    });
  });

  server.tool('effectcraft.render_queue', 'Queue 1–10 comp renders through the engine render queue (renderQueue.add per job, then renderQueue.render) and independently verify every artifact with FFprobe plus a sha256 receipt. Fail-closed: isError when any output is unverified.', {
    projectPath: z.string().min(1),
    jobs: z.array(z.object({
      compId: z.string().min(1),
      outputPath: z.string().min(1),
      format: z.enum(RENDER_FORMATS).optional(),
      resolution: z.enum(['full', 'half', 'third', 'quarter']).optional()
    })).min(1).max(10),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, jobs, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedJobs = jobs.map(job => ({ ...job, outputPath: validateOutputPath(job.outputPath, 'The render output path for comp ' + job.compId) }));
    for (const job of resolvedJobs) await mkdir(path.dirname(job.outputPath), { recursive: true });
    const steps = resolvedJobs.map(job => ({
      // renderQueue.add resolves the comp by id|name and honors format/
      // resolution directly — no comp.open needed even in reopened sessions
      // (probed on 0.24.1).
      id: 'renderQueue.add',
      params: { comp: job.compId, output: job.outputPath, ...(job.format ? { format: job.format } : {}), ...(job.resolution ? { resolution: job.resolution } : {}) }
    }));
    steps.push({ id: 'renderQueue.render', params: { wait: true } }, { id: 'renderQueue.list', params: {} });
    const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'render-queue' });
    const failed = results.find(entry => !entry.ok);
    if (failed) throw new Error('renderQueue session failed at step ' + failed.id + ': ' + JSON.stringify(results).slice(0, 800));
    const jobReceipts = [];
    for (const [index, job] of resolvedJobs.entries()) {
      const failures = [];
      let media = null, byteSize = null, sha256 = null;
      try {
        const info = await stat(job.outputPath);
        if (!info.isFile() || info.size === 0) throw new Error('the artifact is missing or empty');
        byteSize = info.size;
        sha256 = await sha256File(job.outputPath);
        media = await probeMedia(job.outputPath);
        if (!media.videoCodec || !(media.width > 0) || !(media.height > 0)) failures.push({ code: 'MEDIA_VIDEO_MISSING', message: 'The render has no probeable video stream (codec + dimensions).' });
        if (!(media.durationSeconds > 0)) failures.push({ code: 'MEDIA_DURATION_INVALID', message: 'The render has no probeable duration.' });
      } catch (error) {
        failures.push({ code: 'ARTIFACT_UNVERIFIED', message: error.message });
      }
      jobReceipts.push({
        compId: job.compId, outputPath: job.outputPath,
        format: job.format ?? null, resolution: job.resolution ?? null,
        status: results[index]?.result?.status ?? null,
        sha256, byteSize, media, verified: failures.length === 0, failures
      });
    }
    const allVerified = jobReceipts.every(job => job.verified);
    const receipt = {
      ok: allVerified,
      projectPath: resolvedProject,
      jobs: jobReceipts,
      allVerified,
      completedAt: new Date().toISOString()
    };
    return { ...jsonText(receipt), isError: !allVerified };
  });

  server.tool('effectcraft.export_lottie', 'Export a saved .ecproj comp as Lottie JSON (.json/.lottie) via file.exportLottie, then verify the artifact exists, parses as JSON and record its sha256. Sandboxed artifact generation; read-only for the project.', {
    projectPath: z.string().min(1),
    compId: z.string().min(1),
    outputPath: z.string().min(1),
    includeExpressions: z.boolean().default(false),
    textAsShapes: z.boolean().default(false),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, compId, outputPath, includeExpressions, textAsShapes, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The Lottie output path');
    if (!/\.(json|lottie)$/i.test(resolvedOutput)) throw new Error('The Lottie output path must end in .json or .lottie: ' + resolvedOutput);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const steps = [{ id: 'file.exportLottie', params: { comp: compId, path: resolvedOutput, includeExpressions, textAsShapes } }];
    const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'export-lottie' });
    const failed = results.find(entry => !entry.ok);
    if (failed) throw new Error('file.exportLottie failed: ' + JSON.stringify(results).slice(0, 800));
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('file.exportLottie reported success but the artifact is missing or empty: ' + resolvedOutput);
    let lottie;
    try {
      lottie = JSON.parse(await readFile(resolvedOutput, 'utf8'));
    } catch (error) {
      throw new Error('The exported Lottie is not valid JSON (' + resolvedOutput + '): ' + error.message);
    }
    return jsonText({
      ok: true, projectPath: resolvedProject, compId, outputPath: resolvedOutput,
      includeExpressions, textAsShapes,
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput) },
      frames: Number.isFinite(lottie?.op) && Number.isFinite(lottie?.ip) ? Math.round(lottie.op - lottie.ip) : null,
      layers: Array.isArray(lottie?.layers) ? lottie.layers.length : null,
      lottie: { version: lottie?.v ?? null, name: lottie?.nm ?? null, width: lottie?.w ?? null, height: lottie?.h ?? null, frameRate: lottie?.fr ?? null, markers: Array.isArray(lottie?.markers) ? lottie.markers.length : null },
      warnings: results[0]?.result?.warnings ?? []
    });
  });

  server.tool('effectcraft.export_timeline', 'Export a saved .ecproj comp as a timeline interchange file (file.exportTimeline: fcpxml|xml|otio|edl), then verify it exists, is non-empty and (for fcpxml/xml) starts with the XML declaration. Sandboxed artifact generation; read-only for the project.', {
    projectPath: z.string().min(1),
    compId: z.string().min(1).optional(),
    outputPath: z.string().min(1),
    format: z.enum(TIMELINE_EXPORT_FORMATS).default('fcpxml'),
    timeoutMs: timeoutSchema
  }, async ({ projectPath, compId, outputPath, format, timeoutMs }) => {
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedOutput = validateOutputPath(outputPath, 'The timeline output path');
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    const steps = [{ id: 'file.exportTimeline', params: { ...(compId ? { comp: compId } : {}), path: resolvedOutput, format } }];
    const results = await runSession(command, { projectPath: resolvedProject, steps, timeoutMs, label: 'export-timeline' });
    const failed = results.find(entry => !entry.ok);
    if (failed) throw new Error('file.exportTimeline failed: ' + JSON.stringify(results).slice(0, 800));
    const info = await stat(resolvedOutput);
    if (!info.isFile() || info.size === 0) throw new Error('file.exportTimeline reported success but the artifact is missing or empty: ' + resolvedOutput);
    const xmlDeclared = format === 'fcpxml' || format === 'xml';
    const content = xmlDeclared ? await readFile(resolvedOutput, 'utf8') : null;
    if (xmlDeclared && !content.trimStart().startsWith('<?xml')) throw new Error('The exported timeline does not start with the XML declaration: ' + resolvedOutput);
    return jsonText({
      ok: true, projectPath: resolvedProject, compId: compId ?? null, outputPath: resolvedOutput, format,
      artifact: { path: resolvedOutput, byteSize: info.size, sha256: await sha256File(resolvedOutput) },
      export: results[0]?.result ?? null
    });
  });

  server.tool('effectcraft.import_timeline', 'Import a timeline interchange file (.xml/.fcpxml/.otio/.edl/.aaf/.omf) into a saved .ecproj via file.importTimeline, save the project back and report the comps the CLI info summary shows. Requires producer approval.', {
    approval: projectSchema.optional(), projectId: z.string().min(1), runId: z.string().min(1),
    projectPath: z.string().min(1),
    timelinePath: z.string().min(1),
    format: z.enum(TIMELINE_IMPORT_FORMATS).default('auto'),
    timeoutMs: timeoutSchema
  }, async ({ approval, projectId, runId, projectPath, timelinePath, format, timeoutMs }) => {
    const opArgs = { projectId, runId, projectPath, timelinePath, format, timeoutMs };
    const gated = gateApproval({ approval, projectId, runId, toolName: 'effectcraft.import_timeline', opArgs });
    if (gated) return gated;
    const command = await resolveCommand();
    const resolvedProject = requireExistingFile(projectPath, 'The .ecproj project path');
    const resolvedTimeline = requireExistingFile(timelinePath, 'The timeline file');
    const steps = [
      { id: 'file.importTimeline', params: { path: resolvedTimeline, format } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    return runApprovedSession(command, {
      label: 'import-timeline', projectPath: resolvedProject, steps, timeoutMs,
      receipt: async results => {
        const infoOutput = await runEffectCraftCli(command, ['--project', resolvedProject, 'info'], { timeoutMs });
        const summary = infoOutput.stdout.trim();
        const comps = summary.split(/\r?\n/)
          .map(line => line.match(/^\s*item\s+\d+\s+Composition\s+(.+?)\s*$/))
          .filter(Boolean)
          .map(match => match[1]);
        return {
          projectId, runId, approvedBy: approval.approvedBy ?? null,
          projectPath: resolvedProject, timelinePath: resolvedTimeline, format,
          compsCreated: comps.length, comps, summary,
          imported: results[0]?.result ?? null,
          savePath: resolvedProject
        };
      }
    });
  });

  server.tool('effectcraft.list_fonts', 'List the engine font catalog (text.fonts, headless-safe) with an optional substring query: families, styles and origin (bundled/system/user). Read-only.', {
    query: z.string().min(1).max(120).optional(),
    timeoutMs: timeoutSchema
  }, async ({ query, timeoutMs }) => {
    const command = await resolveCommand();
    const steps = [{ id: 'text.fonts', params: query ? { query } : {} }];
    const results = await runSession(command, { steps, timeoutMs, label: 'fonts' });
    const step = results[0];
    if (!step.ok || !step.result) throw new Error('text.fonts returned no font data.');
    return jsonText({ command, query: query ?? null, count: step.result.count, families: step.result.families, added: step.result.added ?? null });
  });

  return server;
}

// HTTP mode for UXP panels: node:http bound strictly to 127.0.0.1, stateless
// streamable-http transport (a fresh transport+server per request — reusing a
// stateless transport causes message-id collisions between clients).
async function startEffectCraftHttpServer({ argv = [], env = process.env } = {}) {
  let port = 7420;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--port') {
      index += 1;
      port = Number(argv[index]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535 (0 picks an ephemeral port).');
    } else if (argument === '--host') {
      index += 1;
      if (argv[index] !== HTTP_HOST) throw new Error('The EffectCraft HTTP transport binds strictly to ' + HTTP_HOST + '; refusing host ' + argv[index] + '.');
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
    const server = buildEffectCraftServer();
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
      console.error('[effectcraft-http] request failed: ' + (error?.message || error));
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, HTTP_HOST, resolve);
  });
  const address = httpServer.address();
  // The bound port is the only thing the client needs; the token value is
  // never printed anywhere.
  process.stdout.write('effectcraft http server listening on ' + HTTP_HOST + ':' + address.port + ' path ' + HTTP_PATH + ' tokenRequired:' + Boolean(token) + '\n');
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
  if (argv.includes('--http')) await startEffectCraftHttpServer({ argv });
  else {
    const server = buildEffectCraftServer();
    await server.connect(new StdioServerTransport());
  }
}

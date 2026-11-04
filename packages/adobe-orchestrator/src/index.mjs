import { createHash, randomUUID } from 'node:crypto';
import { copyFile, access, stat, mkdir, writeFile, chmod } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectAdobeMcp } from '../../adobe-mcp-client/src/index.mjs';
import { validateProject } from '../../core/src/index.mjs';

const APPROVAL_TTL_MS = 30 * 60 * 1000;
const pendingApprovals = new Map();
const ALLOWED_AE_OPERATIONS = new Set([
  'comp.create', 'layer.create_text', 'layer.create_solid',
  'text.set_style', 'transform.set', 'keyframe.add'
]);
const REQUIRED_AE_TOOLS = ['ae_context', 'ae_project_info', 'ae_catalog', 'ae_do', 'ae_save_project', 'ae_comp_info', 'ae_render_frame'];
const REQUIRED_PREMIERE_TOOLS = [
  'verify_premiere_connection', 'get_project_info', 'import_media',
  'create_sequence_from_clips', 'get_active_sequence', 'get_sequence_structure', 'save_project'
];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeName = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'scene';
const seconds = (frames, rate) => frames * rate.denominator / rate.numerator;
const hostMutationTails = new Map();

/** Serialize all project mutations in one Adobe host process. */
export async function acquireHostMutationLock(host) {
  if (!['afterEffects', 'premiere'].includes(host)) throw new Error('Unknown Adobe host lock: ' + host);
  const previous = hostMutationTails.get(host) || Promise.resolve();
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  hostMutationTails.set(host, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (hostMutationTails.get(host) === tail) hostMutationTails.delete(host);
  };
}

function collectSequenceClipNodeIds(structure) {
  const ids = [];
  for (const track of [...(structure.videoTracks || []), ...(structure.audioTracks || [])]) {
    for (const clip of track.clips || []) if (typeof clip.nodeId === 'string' && clip.nodeId) ids.push(clip.nodeId);
  }
  return ids;
}


export function defaultAdobeReceiptDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const root = platform === 'win32'
    ? (env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'))
    : (env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'));
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(root, 'motion-studio', 'runs');
}

async function persistReceipt(host, receipt, receiptDir) {
  const root = path.resolve(receiptDir || defaultAdobeReceiptDirectory());
  await mkdir(root, { recursive: true });
  const file = path.join(root, randomUUID() + '.json');
  const payload = {
    schemaVersion: '1.0.0',
    product: 'Motion Studio',
    host,
    ...receipt,
    steps: (receipt.steps || []).map(step => ({
      tool: step.tool || null,
      operation: step.operation || null,
      ok: step.ok === true,
      resultHash: sha256(JSON.stringify(step.result ?? null)),
      path: step.path || null,
      bytes: step.bytes || null
    }))
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600);
  return file;
}

async function safePersistReceipt(host, receipt, receiptDir) {
  try { return { receiptPath: await persistReceipt(host, receipt, receiptDir) }; }
  catch (error) { return { receiptError: error.message }; }
}

export function parseMcpPayload(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.isError) throw new Error('Adobe MCP tool returned isError=true.');
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const textParts = (result.content || []).filter(item => item?.type === 'text' && typeof item.text === 'string');
  for (const part of textParts) {
    try { return JSON.parse(part.text); } catch {}
  }
  return result;
}

export function unwrapMcpData(payload) {
  let value = payload;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!value || typeof value !== 'object') return value;
    if (value.isError || value.success === false || value.ok === false) {
      throw new Error(value.error || value.message || 'Adobe MCP operation was not successful.');
    }
    if (value.success === true && value.data !== undefined) { value = value.data; continue; }
    if (value.ok === true && value.result !== undefined) { value = value.result; continue; }
    if (value.result !== undefined && value.context !== undefined) { value = value.result; continue; }
    if (value.data !== undefined && Object.keys(value).length <= 4) { value = value.data; continue; }
    return value;
  }
  throw new Error('Adobe MCP result contained excessive nested envelopes.');
}

export function validateDeclaredOperationArgs(operation, args) {
  if (!operation || typeof operation !== 'object') throw new Error('AE operation definition is missing.');
  const params = Array.isArray(operation.params) ? operation.params : [];
  const allowed = new Set(params.map(param => param.name));
  const unknown = Object.keys(args).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error('AE operation ' + operation.name + ' received undeclared arguments: ' + unknown.join(', '));
  for (const param of params) {
    const value = args[param.name];
    if (value === undefined) {
      if (param.required) throw new Error('AE operation ' + operation.name + ' is missing required argument: ' + param.name);
      continue;
    }
    const valid = param.type === 'any'
      || (param.type === 'string' && typeof value === 'string')
      || (param.type === 'number' && typeof value === 'number' && Number.isFinite(value))
      || (param.type === 'boolean' && typeof value === 'boolean')
      || (param.type === 'array' && Array.isArray(value))
      || (param.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value));
    if (!valid) throw new Error('AE operation ' + operation.name + ' parameter ' + param.name + ' must be ' + param.type);
  }
  return true;
}

function requiredTools(toolList, names, host) {
  const present = new Set((toolList.tools || []).map(tool => tool.name));
  const missing = names.filter(name => !present.has(name));
  if (missing.length) throw new Error(host + ' MCP is missing required tools: ' + missing.join(', '));
  return toolList.tools || [];
}

function toolDescription(tools, name) {
  return tools.find(tool => tool.name === name);
}

async function call(connection, name, args = {}) {
  const raw = await connection.callTool(name, args);
  const parsed = parseMcpPayload(raw);
  return unwrapMcpData(parsed);
}

async function aeOperationCatalog(connection, category) {
  const payload = parseMcpPayload(await connection.callTool('ae_catalog', { category }));
  const data = unwrapMcpData(payload);
  if (!Array.isArray(data.operations)) throw new Error('After Effects ae_catalog did not return an operations array for category ' + category);
  return data.operations;
}

function assertAbsoluteFilePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(label + ' must be an absolute file path.');
  }
  return path.resolve(value);
}

async function assertExistingFile(value, label) {
  const file = assertAbsoluteFilePath(value, label);
  const info = await stat(file);
  if (!info.isFile() || info.size < 1) throw new Error(label + ' must be an existing non-empty regular file.');
  return file;
}

export async function assertNewBackupPath(value, sourceFile, label) {
  const backup = assertAbsoluteFilePath(value, label);
  if (backup === path.resolve(sourceFile)) throw new Error(label + ' must differ from the active project path.');
  if (path.extname(backup).toLowerCase() !== path.extname(sourceFile).toLowerCase()) {
    throw new Error(label + ' must use the same file extension as the source project.');
  }
  const parent = path.dirname(backup);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw new Error(label + ' parent must be an existing directory.');
  try {
    await access(backup);
    throw new Error(label + ' already exists. Choose a new backup path; existing files are never overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return backup;
}

function findStringProperty(object, keys, maxDepth = 5) {
  const seen = new Set();
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) return null;
    seen.add(value);
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key];
    }
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return visit(object, 0);
}

function findBooleanProperty(object, keys, maxDepth = 5) {
  const seen = new Set();
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) return null;
    seen.add(value);
    for (const key of keys) if (typeof value[key] === 'boolean') return value[key];
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  return visit(object, 0);
}

function colorToRgb(value, fallback = [1, 1, 1]) {
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(x => Number.isFinite(x))) {
    return value.slice(0, 3).map(x => Math.max(0, Math.min(1, Number(x))));
  }
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
    return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
  }
  return fallback;
}

function layerText(layer) {
  if (typeof layer.content === 'string') return layer.content;
  return String(layer.content?.text ?? layer.text ?? '');
}

export function buildAfterEffectsScenePlan(project, sceneId) {
  const validation = validateProject(project);
  if (!validation.valid) throw new Error('Invalid Canonical Video IR: ' + JSON.stringify(validation.issues));
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('Scene not found in Canonical Video IR: ' + sceneId);
  const rate = project.project.frameRate;
  const duration = seconds(scene.durationFrames, rate);
  const compName = 'MS_' + safeName(project.project.id) + '_' + safeName(scene.id) + '_r' + (project.project.revision || 1);
  const compBackground = colorToRgb(project.brand?.colors?.background, [0.08, 0.08, 0.08]);
  const operations = [{
    operation: 'comp.create',
    args: { name: compName, width: project.project.canvas.width, height: project.project.canvas.height, fps: rate.numerator / rate.denominator, duration, bgColor: compBackground },
    purpose: 'Create a dedicated composition for the approved IR scene.'
  }];
  const warnings = [];
  const supportedLayers = [];
  for (const layer of scene.layers || []) {
    if (!['text', 'shape'].includes(layer.kind)) {
      warnings.push({ code: 'AE_LAYER_UNSUPPORTED', layerId: layer.id, kind: layer.kind, routedTo: layer.engineHint || 'other-engine', message: 'Only text and rectangular solid layers are in the first AE adapter.' });
      continue;
    }
    const transform = layer.transform || layer.layout || {};
    const width = Number(transform.width ?? project.project.canvas.width);
    const height = Number(transform.height ?? (layer.kind === 'text' ? 180 : project.project.canvas.height));
    const x = Number(transform.x ?? 0), y = Number(transform.y ?? 0);
    if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new Error('Scene layer has invalid geometry: ' + layer.id);
    }
    const layerName = 'MS_' + safeName(layer.id);
    if (layer.kind === 'text') {
      const boxSize = [width, height];
      const createArgs = { comp: compName, text: layerText(layer), name: layerName, boxSize, boxPosition: [0, 0], orientation: 'horizontal' };
      operations.push({ operation: 'layer.create_text', args: createArgs, purpose: 'Create editable text layer.' });
      const style = layer.style || {};
      const typography = layer.typography || {};
      const styleArgs = { comp: compName, layer: layerName, fontSize: Number(typography.sizePx || 48), fillColor: colorToRgb(style.color, [1, 1, 1]), justification: ({ left: 'left', center: 'center', right: 'right' })[typography.alignment || 'left'] || 'left' };
      const postScriptName = typography.postScriptName || typography.fontPostScriptName;
      if (typeof postScriptName === 'string' && postScriptName.trim()) styleArgs.font = postScriptName.trim();
      else if (typeof typography.family === 'string' && typography.family.trim()) {
        warnings.push({ code: 'AE_FONT_POSTSCRIPT_UNSPECIFIED', layerId: layer.id, requestedFamily: typography.family, message: 'After Effects requires a PostScript font name for deterministic font selection; the host default font will be used unless postScriptName is supplied.' });
      }
      operations.push({ operation: 'text.set_style', args: styleArgs, purpose: 'Apply supported text typography.' });
    } else {
      operations.push({ operation: 'layer.create_solid', args: { comp: compName, name: layerName, color: colorToRgb(layer.style?.backgroundColor || layer.style?.color, [1, 1, 1]), width, height }, purpose: 'Create solid rectangle layer.' });
    }
    const position = [x + width / 2, y + height / 2];
    const opacity = Math.max(0, Math.min(100, Number((layer.style?.opacity ?? 1) * 100)));
    operations.push({ operation: 'transform.set', args: { comp: compName, layer: layerName, position, opacity }, purpose: 'Place and set opacity for the layer.' });
    const motionPreset = layer.motion?.preset;
    if (['fade', 'fade-up'].includes(motionPreset)) {
      const localStart = Number(layer.startFrame ?? 0);
      const fadeFrames = Math.max(1, Math.min(Number(layer.motion?.durationFrames || Math.round(rate.numerator / rate.denominator * 0.6)), Math.max(1, scene.durationFrames - localStart)));
      const startTime = seconds(localStart, rate);
      const endTime = seconds(localStart + fadeFrames, rate);
      operations.push({ operation: 'keyframe.add', args: { comp: compName, layer: layerName, property: ['Transform', 'Opacity'], time: startTime, value: 0 }, purpose: 'Start the layer fade.' });
      operations.push({ operation: 'keyframe.add', args: { comp: compName, layer: layerName, property: ['Transform', 'Opacity'], time: endTime, value: opacity }, purpose: 'Complete the layer fade.' });
      if (motionPreset === 'fade-up' && layer.kind === 'text') {
        operations.push({ operation: 'keyframe.add', args: { comp: compName, layer: layerName, property: ['Transform', 'Position'], time: startTime, value: [position[0], position[1] + 40] }, purpose: 'Begin the text slide-up.' });
        operations.push({ operation: 'keyframe.add', args: { comp: compName, layer: layerName, property: ['Transform', 'Position'], time: endTime, value: position }, purpose: 'Finish the text slide-up.' });
      }
    }
    supportedLayers.push(layer.id);
  }
  return {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    irHash: sha256(JSON.stringify(project)),
    sceneId,
    composition: { name: compName, width: project.project.canvas.width, height: project.project.canvas.height, fps: rate.numerator / rate.denominator, duration },
    operations,
    supportedLayerIds: supportedLayers,
    warnings
  };
}

export function createApprovalStore({ ttlMs = APPROVAL_TTL_MS, now = () => Date.now() } = {}) {
  const records = new Map();
  return {
    issue(record) {
      const token = randomUUID();
      records.set(token, { ...record, expiresAt: now() + ttlMs, consumed: false });
      return { approvalId: token, expiresAt: now() + ttlMs };
    },
    consume(token) {
      const record = records.get(token);
      if (!record) throw new Error('Approval token is unknown or has already been consumed.');
      records.delete(token);
      if (record.consumed || record.expiresAt < now()) throw new Error('Approval token has expired or was already consumed. Create a new preview.');
      return record;
    },
    get size() { return records.size; }
  };
}

export function validateAePlanAgainstCatalog(plan, catalogs) {
  const operations = new Map();
  for (const category of catalogs || []) for (const operation of category.operations || []) operations.set(operation.name, operation);
  const validated = [];
  for (const step of plan.operations) {
    if (!ALLOWED_AE_OPERATIONS.has(step.operation)) throw new Error('AE operation is outside Motion Studio allowlist: ' + step.operation);
    const definition = operations.get(step.operation);
    if (!definition) throw new Error('AE operation is not available in the live catalog: ' + step.operation);
    validateDeclaredOperationArgs(definition, step.args);
    validated.push(step);
  }
  return validated;
}

export function validatePremiereRenderInputs(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('At least one rendered scene path is required.');
  const absolute = paths.map((value, index) => assertAbsoluteFilePath(value, 'renderedScenePaths[' + index + ']'));
  if (new Set(absolute).size !== absolute.length) throw new Error('Duplicate scene render paths are not allowed.');
  return absolute;
}

export async function previewAfterEffectsScene({ project, sceneId, backupPath, connect = connectAdobeMcp, approvalStore = defaultApprovalStore } = {}) {
  const plan = buildAfterEffectsScenePlan(project, sceneId);
  // Edit-scoped categories expose mutation schemas through ae_catalog, but preview calls only read-only tools.
  const connection = await connect({ app: 'afterEffects', allowEdits: true });
  try {
    const toolList = await connection.listTools();
    requiredTools(toolList, REQUIRED_AE_TOOLS, 'After Effects');
    const context = await call(connection, 'ae_context');
    const projectInfo = await call(connection, 'ae_project_info');
    const projectFile = findStringProperty(projectInfo, ['file', 'path', 'projectPath', 'project_path']);
    if (!projectFile || !path.isAbsolute(projectFile)) throw new Error('After Effects project must be saved to an absolute path before a scene can be edited.');
    if (findBooleanProperty(projectInfo, ['dirty', 'isDirty']) !== false) throw new Error('After Effects dirty state is not confirmed false. Save the project in After Effects and retry the preview.');
    if (Array.isArray(projectInfo.items) && projectInfo.items.some(item => item?.name === plan.composition.name)) {
      throw new Error('An After Effects project item already uses the planned composition name. Rename the existing item or revise the scene before previewing again.');
    }
    const sourceFile = await assertExistingFile(projectFile, 'After Effects project');
    const backup = await assertNewBackupPath(backupPath, sourceFile, 'After Effects backupPath');
    const categories = [...new Set(plan.operations.map(item => item.operation.split('.')[0]))];
    const catalogs = [];
    for (const category of categories) catalogs.push(await aeOperationCatalog(connection, category));
    validateAePlanAgainstCatalog(plan, catalogs);
    const previewData = {
      host: 'afterEffects',
      plan,
      projectFile: sourceFile,
      backupPath: backup,
      contextHash: sha256(JSON.stringify({ context, projectInfo })),
      projectInfoHash: sha256(JSON.stringify(projectInfo)),
      tools: toolList.tools.map(tool => tool.name)
    };
    const issued = approvalStore.issue(previewData);
    return { ...issued, plan, host: 'afterEffects', projectFile: sourceFile, warnings: plan.warnings, backupRequired: backup };
  } finally { await connection.close(); }
}

export async function applyAfterEffectsScene({ approvalId, approved = false, connect = connectAdobeMcp, approvalStore = defaultApprovalStore, receiptDir } = {}) {
  if (approved !== true) throw new Error('After Effects scene mutation requires explicit user approval.');
  const preview = approvalStore.consume(approvalId);
  if (preview.host !== 'afterEffects') throw new Error('Approval token is not for After Effects.');
  const connection = await connect({ app: 'afterEffects', allowEdits: true });
  const releaseMutationLock = await acquireHostMutationLock('afterEffects');
  const steps = [];
  const startedAt = new Date().toISOString();
  const receiptBase = { runId: randomUUID(), startedAt, projectFile: preview.projectFile, backupPath: preview.backupPath, projectId: preview.plan.projectId, projectRevision: preview.plan.projectRevision, irHash: preview.plan.irHash, sceneId: preview.plan.sceneId, planHash: sha256(JSON.stringify(preview.plan)), approvalIdHash: sha256(approvalId) };
  try {
    const toolList = await connection.listTools();
    requiredTools(toolList, REQUIRED_AE_TOOLS, 'After Effects');
    const projectInfo = await call(connection, 'ae_project_info');
    const currentPath = findStringProperty(projectInfo, ['file', 'path', 'projectPath', 'project_path']);
    if (path.resolve(currentPath || '') !== preview.projectFile) throw new Error('After Effects project identity changed after preview; no mutation was attempted.');
    if (findBooleanProperty(projectInfo, ['dirty', 'isDirty']) !== false) throw new Error('After Effects dirty state is no longer confirmed false; no mutation was attempted.');
    if (sha256(JSON.stringify(projectInfo)) !== preview.projectInfoHash) throw new Error('After Effects project state changed after preview; create a fresh preview.');
    const categories = [...new Set(preview.plan.operations.map(item => item.operation.split('.')[0]))];
    const catalogs = [];
    for (const category of categories) catalogs.push(await aeOperationCatalog(connection, category));
    validateAePlanAgainstCatalog(preview.plan, catalogs);
    await copyFile(preview.projectFile, preview.backupPath, fsConstants.COPYFILE_EXCL);
    for (const step of preview.plan.operations) {
      const result = await call(connection, 'ae_do', { operation: step.operation, args: step.args });
      steps.push({ operation: step.operation, ok: true, result });
    }
    const saved = await call(connection, 'ae_save_project', {});
    if (saved.saved !== true) throw new Error('After Effects save did not return saved:true; inspect the project before retrying.');
    steps.push({ tool: 'ae_save_project', ok: true, result: saved });
    const readback = await call(connection, 'ae_comp_info', { nameOrId: preview.plan.composition.name });
    if (!readback || typeof readback !== 'object' || readback.ok !== true || readback.found !== true || readback.name !== preview.plan.composition.name) {
      throw new Error('After Effects composition readback did not verify the created composition.');
    }
    const expectedLayerNames = preview.plan.supportedLayerIds.map(id => 'MS_' + safeName(id));
    const observedLayerNames = Array.isArray(readback.layers) ? readback.layers.map(layer => layer.name) : [];
    const missingLayerNames = expectedLayerNames.filter(name => !observedLayerNames.includes(name));
    if (missingLayerNames.length) throw new Error('After Effects composition is missing expected layers: ' + missingLayerNames.join(', '));
    const evidenceDir = path.join(os.tmpdir(), 'motion-studio', 'adobe-evidence');
    await mkdir(evidenceDir, { recursive: true });
    const framePath = path.join(evidenceDir, safeName(preview.plan.composition.name) + '-proof.png');
    const frame = await call(connection, 'ae_render_frame', {
      compNameOrId: preview.plan.composition.name,
      time: Math.min(preview.plan.composition.duration / 2, Math.max(0, preview.plan.composition.duration - 1 / preview.plan.composition.fps)),
      outPath: framePath,
      colorManaged: 'off',
      analyze: true
    });
    const frameFile = frame.writtenTo || frame.frames?.[0]?.writtenTo || framePath;
    const frameInfo = await stat(frameFile);
    if (!frameInfo.isFile() || frameInfo.size < 1) throw new Error('After Effects frame proof was not written as a non-empty PNG.');
    steps.push({ tool: 'ae_render_frame', ok: true, path: frameFile, bytes: frameInfo.size, analysis: frame.analysis || frame.frames?.[0]?.analysis || null });
    const outcome = { status: 'applied', verified: true, host: 'afterEffects', projectFile: preview.projectFile, backupPath: preview.backupPath, composition: preview.plan.composition, supportedLayerIds: preview.plan.supportedLayerIds, warnings: preview.plan.warnings, steps, readback, frameProof: { path: frameFile, bytes: frameInfo.size, analysis: frame.analysis || frame.frames?.[0]?.analysis || null } };
    const persisted = await safePersistReceipt('afterEffects', { ...receiptBase, ...outcome, finishedAt: new Date().toISOString() }, receiptDir);
    return { ...outcome, ...persisted };
  } catch (error) {
    const outcome = { status: 'needs-reconciliation', verified: false, host: 'afterEffects', backupPath: preview.backupPath, steps, error: error.message, retryAllowed: false };
    const persisted = await safePersistReceipt('afterEffects', { ...receiptBase, ...outcome, finishedAt: new Date().toISOString() }, receiptDir);
    return { ...outcome, ...persisted };
  } finally {
    try { await connection.close(); } finally { releaseMutationLock(); }
  }
}

export async function previewPremiereAssembly({ renderedScenePaths, backupPath, sequenceName, backend = 'cep', exportPath, presetPath, connect = connectAdobeMcp, approvalStore = defaultApprovalStore } = {}) {
  const paths = validatePremiereRenderInputs(renderedScenePaths);
  if (paths.length > 100) throw new Error('The 0.4 Premiere workflow is limited to 100 scene files so bounded video/audio track readback stays within the upstream 200-clip page contract.');
  if (typeof sequenceName !== 'string' || !sequenceName.trim()) throw new Error('sequenceName must be provided.');
  if (backend !== 'cep') throw new Error('The 0.4 Premiere assembly workflow currently requires the CEP compatibility bridge. UXP uses a different import/sequence-edit API and is not yet implemented in this workflow.');
  const checked = [];
  for (const file of paths) checked.push(await assertExistingFile(file, 'rendered scene'));
  const connection = await connect({ app: 'premiere', allowEdits: false });
  try {
    const toolList = await connection.listTools();
    requiredTools(toolList, ['verify_premiere_connection', 'get_project_info'], 'Premiere Pro');
    const connectionReport = await call(connection, 'verify_premiere_connection', { backend });
    if (connectionReport.overall !== 'ready') throw new Error('Premiere connection is not ready: ' + JSON.stringify(connectionReport));
    const projectInfo = await call(connection, 'get_project_info');
    const projectFile = findStringProperty(projectInfo, ['path', 'projectPath', 'project_path', 'projectFile', 'project_file']);
    if (!projectFile || !path.isAbsolute(projectFile)) throw new Error('Premiere project must be saved to an absolute path before assembly.');
    const sourceFile = await assertExistingFile(projectFile, 'Premiere project');
    const backup = await assertNewBackupPath(backupPath, sourceFile, 'Premiere backupPath');
    let output = null;
    if (presetPath && !exportPath) throw new Error('An AME preset path is meaningful only when exportPath is also provided.');
    let preset = null;
    if (presetPath) {
      preset = await assertExistingFile(presetPath, 'AME preset');
      if (path.extname(preset).toLowerCase() !== '.epr') throw new Error('AME preset must be an .epr file.');
    }
    if (exportPath) {
      output = assertAbsoluteFilePath(exportPath, 'exportPath');
      const exportParent = await stat(path.dirname(output));
      if (!exportParent.isDirectory()) throw new Error('exportPath parent must be an existing directory.');
      try { await access(output); throw new Error('exportPath already exists. Choose a new path; existing exports are never overwritten.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const issued = approvalStore.issue({
      host: 'premiere', backend, projectFile: sourceFile, backupPath: backup,
      renderedScenePaths: checked, sequenceName: sequenceName.trim(), exportPath: output, presetPath: preset,
      projectInfoHash: sha256(JSON.stringify(projectInfo))
    });
    return { ...issued, host: 'premiere', backend, projectFile: sourceFile, backupPath: backup, renderedScenePaths: checked, sequenceName: sequenceName.trim(), exportPath: output, presetPath: preset, mutationScope: 'new-sequence-only' };
  } finally { await connection.close(); }
}

export async function applyPremiereAssembly({ approvalId, approved = false, connect = connectAdobeMcp, approvalStore = defaultApprovalStore, receiptDir } = {}) {
  if (approved !== true) throw new Error('Premiere assembly requires explicit user approval.');
  const preview = approvalStore.consume(approvalId);
  if (preview.host !== 'premiere') throw new Error('Approval token is not for Premiere Pro.');
  const connection = await connect({ app: 'premiere', allowEdits: true });
  const releaseMutationLock = await acquireHostMutationLock('premiere');
  const steps = [];
  const startedAt = new Date().toISOString();
  const receiptBase = { runId: randomUUID(), startedAt, projectFile: preview.projectFile, backupPath: preview.backupPath, projectInfoHash: preview.projectInfoHash, renderedScenePaths: preview.renderedScenePaths, sequenceName: preview.sequenceName, exportPath: preview.exportPath, presetPath: preview.presetPath, backend: preview.backend, approvalIdHash: sha256(approvalId) };
  try {
    const toolList = await connection.listTools();
    const required = [...REQUIRED_PREMIERE_TOOLS, ...(preview.exportPath ? ['export_sequence', 'verify_delivery_file'] : [])];
    requiredTools(toolList, required, 'Premiere Pro');
    const connectionReport = await call(connection, 'verify_premiere_connection', { backend: preview.backend });
    if (connectionReport.overall !== 'ready') throw new Error('Premiere connection is not ready: ' + JSON.stringify(connectionReport));
    const projectInfo = await call(connection, 'get_project_info');
    const currentPath = findStringProperty(projectInfo, ['path', 'projectPath', 'project_path', 'projectFile', 'project_file']);
    if (path.resolve(currentPath || '') !== preview.projectFile) throw new Error('Premiere project identity changed after preview; no mutation was attempted.');
    if (sha256(JSON.stringify(projectInfo)) !== preview.projectInfoHash) throw new Error('Premiere project/active-sequence state changed after preview; create a fresh preview.');
    const initialSave = await call(connection, 'save_project', { expected_project_path: preview.projectFile });
    if (initialSave.verified !== true) throw new Error('Premiere pre-edit save was not verified; no backup or import was attempted.');
    steps.push({ tool: 'save_project-before-backup', ok: true, result: initialSave });
    await copyFile(preview.projectFile, preview.backupPath, fsConstants.COPYFILE_EXCL);
    const projectGuard = preview.backend === 'cep' ? { expected_project_path: preview.projectFile } : {};
    const imported = await call(connection, 'import_media', { file_paths: preview.renderedScenePaths, suppress_ui: true, ...projectGuard });
    steps.push({ tool: 'import_media', ok: imported.verified === true, result: imported });
    if (imported.verified !== true || !Array.isArray(imported.items) || imported.items.length !== preview.renderedScenePaths.length) {
      throw new Error('Premiere media import did not return a verified exact item list; inspect the project before retrying.');
    }
    const itemIds = imported.items.map(item => item.nodeId);
    if (itemIds.some(id => typeof id !== 'string' || !id)) throw new Error('Premiere media import omitted one or more node IDs; inspect the project before retrying.');
    const created = await call(connection, 'create_sequence_from_clips', { name: preview.sequenceName, item_ids: itemIds, ...projectGuard });
    steps.push({ tool: 'create_sequence_from_clips', ok: created.verified === true, result: created });
    if (created.verified !== true || created.requestedClipCount !== itemIds.length) {
      throw new Error('Premiere did not verify the new sequence and all imported clip placements. Inspect the project before retrying.');
    }
    const activeSequence = await call(connection, 'get_active_sequence', { track_type: 'both', ...projectGuard });
    const activeInfo = activeSequence.sequence || activeSequence.activeSequence || activeSequence;
    const observedSequenceId = activeInfo.id || activeInfo.sequenceId || activeInfo.sequence_id;
    if (!observedSequenceId || String(observedSequenceId) !== String(created.id)) {
      throw new Error('Premiere active sequence does not match the newly created sequence; inspect the project before retrying.');
    }
    const structurePages = [];
    let clipOffset = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await call(connection, 'get_sequence_structure', {
        track_type: 'both', sequence_id: String(created.id), clip_offset: clipOffset, clip_limit: 200, ...projectGuard
      });
      if (!page || typeof page !== 'object') throw new Error('Premiere sequence structure readback failed.');
      structurePages.push(page);
      const nextOffset = page.pagination?.nextOffset;
      if (nextOffset === null || nextOffset === undefined) break;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= clipOffset) throw new Error('Premiere sequence structure returned an invalid pagination offset.');
      clipOffset = nextOffset;
      if (pageIndex === 9) throw new Error('Premiere sequence structure exceeded the 10-page verification limit; inspect before retrying.');
    }
    const structure = structurePages[0];
    const observedClipIds = structurePages.flatMap(collectSequenceClipNodeIds);
    const missingClipIds = itemIds.filter(id => !observedClipIds.includes(id));
    if (missingClipIds.length) throw new Error('Premiere sequence structure is missing imported clip IDs: ' + missingClipIds.join(', '));
    if (observedClipIds.length < itemIds.length) throw new Error('Premiere sequence structure contains fewer clip placements than imported sources.');
    steps.push({ tool: 'get_sequence_structure', ok: true, pageCount: structurePages.length, result: structurePages });
    const saved = await call(connection, 'save_project', { ...projectGuard });
    if (saved.verified !== true) throw new Error('Premiere save was not verified by fresh disk evidence; inspect the project before retrying.');
    steps.push({ tool: 'save_project', ok: true, result: saved });
    let exportReceipt = null;
    if (preview.exportPath) {
      exportReceipt = await call(connection, 'export_sequence', { output_path: preview.exportPath, ...(preview.presetPath ? { preset_path: preview.presetPath } : {}), ...projectGuard });
      if (exportReceipt.verified !== true) throw new Error('Premiere export did not return verified completion; inspect the output and Media Encoder state before retrying.');
      const delivery = await call(connection, 'verify_delivery_file', { output_path: preview.exportPath, checksum_algorithm: 'sha256' });
      if (delivery.verified !== true) throw new Error('Premiere delivery file did not pass its checksum/size verification.');
      steps.push({ tool: 'verify_delivery_file', ok: true, result: delivery });
    }
    const outcome = { status: 'applied', verified: true, host: 'premiere', backend: preview.backend, projectFile: preview.projectFile, backupPath: preview.backupPath, sequence: created, structure, export: exportReceipt, delivery: exportReceipt ? steps.at(-1).result : null, steps };
    const persisted = await safePersistReceipt('premiere', { ...receiptBase, ...outcome, finishedAt: new Date().toISOString() }, receiptDir);
    return { ...outcome, ...persisted };
  } catch (error) {
    const outcome = { status: 'needs-reconciliation', verified: false, host: 'premiere', backend: preview.backend, backupPath: preview.backupPath, steps, error: error.message, retryAllowed: false };
    const persisted = await safePersistReceipt('premiere', { ...receiptBase, ...outcome, finishedAt: new Date().toISOString() }, receiptDir);
    return { ...outcome, ...persisted };
  } finally {
    try { await connection.close(); } finally { releaseMutationLock(); }
  }
}

const defaultApprovalStore = createApprovalStore();

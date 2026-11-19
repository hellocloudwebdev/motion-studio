import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../../core/src/index.mjs';
import { probeMedia, inspectMedia } from '../../ffmpeg/src/index.mjs';
import { craftCommandCandidates } from '../../craft-mcp-client/src/index.mjs';

// EffectCraft adapter (2026-11-15): turns Canonical Video IR scenes into
// ordered EffectCraft engine commands, runs them headless through
// `effectcraft-cli run --commands`, saves a .ecproj in the project workspace
// and renders the comp to an independently verified MP4. Pure planning is a
// deterministic function of the IR; execution uses fixed argv, no shell.

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEX = /^#[\da-f]{6}$/i;
const SUPPORTED_LAYER_KINDS = new Set(['shape', 'text']);
// EffectCraft's 3D primitives use their own kind names; the IR uses the
// Blender-style names, so the map converts.
const PRIMITIVE_KINDS = new Set(['cube', 'sphere', 'plane', 'torus', 'cone', 'cylinder']);
const IR_PRIMITIVE_TO_EFFECTCRAFT = { box: 'cube', sphere: 'sphere', plane: 'plane', torus: 'torus', cone: 'cone', cylinder: 'cylinder' };

function inside(root, target, label) {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(label + ' must be a child path inside the project workspace.');
  return resolvedTarget;
}

function secondsOf(frames, fpsValue) {
  return Math.round((frames / fpsValue) * 10000) / 10000;
}

function rgbOf(hex) {
  const match = HEX.exec(hex || '');
  if (!match) return null;
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

// IR effect params use the engine's display names ("Map Black To"); the
// engine's property ids are lowerCamelCase ("mapBlackTo").
function effectParamId(displayName) {
  return String(displayName)
    .trim()
    .split(/\s+/)
    .map((word, index) => index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

// Effect entries from the IR: [{name, params?{DisplayName: value}, time?}].
// Returns the apply step + param steps. Effect indices are per-layer:
// effects/#1 is the first effect applied on that layer.
function effectStepsFor(layerEffects, layerName, issues, sceneId, layerId) {
  const steps = [];
  if (!Array.isArray(layerEffects)) return steps;
  let effectIndex = 0;
  for (const effect of layerEffects) {
    if (!effect || typeof effect.name !== 'string' || !effect.name.trim()) {
      issues.push({ code: 'EFFECTCRAFT_EFFECT_NAME_REQUIRED', severity: 'error', sceneId, layerId, message: 'Every effect needs a non-empty name.' });
      continue;
    }
    effectIndex += 1;
    steps.push({ id: 'effect.apply', params: { effect: effect.name.trim(), layers: [layerName] } });
    if (effect.params && typeof effect.params === 'object' && !Array.isArray(effect.params)) {
      for (const [displayName, value] of Object.entries(effect.params)) {
        if (!displayName.trim()) { issues.push({ code: 'EFFECTCRAFT_EFFECT_PARAM_INVALID', severity: 'error', sceneId, layerId, message: 'Effect param names must be non-empty.' }); continue; }
        steps.push({ id: 'prop.set', params: { layer: layerName, path: 'effects/#' + effectIndex + '/' + effectParamId(displayName), value } });
      }
    }
  }
  return steps;
}

// Motion presets become entrance keyframes on the first motion.durationFrames
// (default 24) of the scene. Scale/opacity are percent-valued in EffectCraft;
// position is a vec3 with z always 0 in 2D comps.
function presetKeyframes(preset, target, layer, fps) {
  const durationFrames = Math.max(1, Math.min(Number(layer?.motion?.durationFrames) || 24, 240));
  const delayFrames = Math.max(0, Number(layer?.motion?.delayFrames) || 0);
  const start = secondsOf(delayFrames, fps);
  const end = secondsOf(delayFrames + durationFrames, fps);
  const frames = [];
  switch (preset) {
    case 'fade':
      frames.push({ path: 'transform/opacity', value: 0, time: start }, { path: 'transform/opacity', value: 100, time: end });
      break;
    case 'fade-up':
      frames.push(
        { path: 'transform/opacity', value: 0, time: start },
        { path: 'transform/position', value: [target.x, target.y + 40, 0], time: start },
        { path: 'transform/opacity', value: 100, time: end },
        { path: 'transform/position', value: [target.x, target.y, 0], time: end }
      );
      break;
    case 'slide-up':
      frames.push(
        { path: 'transform/position', value: [target.x, target.y + 120, 0], time: start },
        { path: 'transform/position', value: [target.x, target.y, 0], time: end }
      );
      break;
    case 'slide-left':
      frames.push(
        { path: 'transform/position', value: [target.x + 160, target.y, 0], time: start },
        { path: 'transform/position', value: [target.x, target.y, 0], time: end }
      );
      break;
    case 'slide-right':
      frames.push(
        { path: 'transform/position', value: [target.x - 160, target.y, 0], time: start },
        { path: 'transform/position', value: [target.x, target.y, 0], time: end }
      );
      break;
    case 'float':
      frames.push(
        { path: 'transform/position', value: [target.x, target.y - 20, 0], time: start },
        { path: 'transform/position', value: [target.x, target.y + 20, 0], time: end }
      );
      break;
    case 'zoom':
      frames.push(
        { path: 'transform/scale', value: [115, 115, 100], time: start },
        { path: 'transform/scale', value: [100, 100, 100], time: end }
      );
      break;
    case 'rotate':
      frames.push(
        { path: 'transform/rotation', value: 0, time: start },
        { path: 'transform/rotation', value: 180, time: end }
      );
      break;
    default:
      break;
  }
  return frames;
}

// IR layer.expressions: [{path, expression}] -> prop.setExpression steps.
// Expressions are authored in the Canonical Video IR (creative-side intent,
// like After Effects expressions) and run inside EffectCraft's own engine
// sandbox; Motion Studio only forwards them verbatim and records them in the
// receipt. Paths are restricted to the transform namespace.
function expressionStepsFor(expressions, layerName, issues, sceneId) {
  const steps = [];
  if (!Array.isArray(expressions)) return steps;
  for (const entry of expressions) {
    const expressionPath = typeof entry?.path === 'string' ? entry.path.trim() : '';
    const expression = typeof entry?.expression === 'string' ? entry.expression.trim() : '';
    if (!expressionPath || !expression) {
      issues.push({ code: 'EFFECTCRAFT_EXPRESSION_INVALID', severity: 'error', sceneId, layerId: layerName, message: 'Expressions need a non-empty path and expression.' });
      continue;
    }
    if (!expressionPath.startsWith('transform/')) {
      issues.push({ code: 'EFFECTCRAFT_EXPRESSION_PATH_UNSUPPORTED', severity: 'error', sceneId, layerId: layerName, message: 'Expression paths are restricted to transform/* properties (received ' + expressionPath + ').' });
      continue;
    }
    steps.push({ id: 'prop.setExpression', params: { layer: layerName, path: expressionPath, expression } });
  }
  return steps;
}

// Pure, deterministic planner: Canonical Video IR scene -> EffectCraft engine
// command steps. Unsupported layer kinds are reported, never silently
// dropped. The plan only uses live-verified command ids and property paths.
// Asset layers (image/video) become phase-two placements: session 1 imports
// the footage items, and the driver resolves each asset's item id (dynamic,
// runtime-assigned) before emitting layer.addItem into session 2.
export function planEffectCraftScene(project, sceneId) {
  const validation = validateProject(project);
  if (!validation.valid) return { valid: false, issues: validation.issues };
  const scene = (project.scenes || []).find(item => item?.id === sceneId);
  if (!scene) return { valid: false, issues: [{ code: 'SCENE_NOT_FOUND', sceneId }] };
  const issues = [];
  const skipped = [];
  const steps = [];
  const assetLayers = [];
  const fps = project.project.frameRate.numerator / project.project.frameRate.denominator;
  const durationSeconds = secondsOf(scene.durationFrames, fps);
  const canvas = project.project.canvas;
  const background = rgbOf(project.brand?.colors?.background) || [0.06, 0.06, 0.07];
  steps.push({ id: 'comp.new', params: { name: scene.id, width: canvas.width, height: canvas.height, frameRate: fps, duration: durationSeconds, background: project.brand?.colors?.background || '#101010', ...(scene.layers?.some(layer => layer?.kind === '3d' || layer?.kind === 'camera' || layer?.kind === 'light') ? { renderer: 'advanced3D' } : {}) } });
  const assetsById = new Map((Array.isArray(project.assets) ? project.assets : []).filter(asset => asset && typeof asset.id === 'string').map(asset => [asset.id, asset]));
  let layerCounter = 0;
  for (const layer of Array.isArray(scene.layers) ? scene.layers : []) {
    const layerLabel = layer?.id || 'layer-' + (++layerCounter);
    const name = 'MS-' + String(layerLabel).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    const preset = layer?.motion?.preset;
    const content = layer?.content && typeof layer.content === 'object' && !Array.isArray(layer.content) ? layer.content : {};
    const isAssetKind = layer?.kind === 'image' || layer?.kind === 'video';
    const is3dKind = layer?.kind === '3d' || layer?.kind === 'camera' || layer?.kind === 'light';
    if (!SUPPORTED_LAYER_KINDS.has(layer?.kind) && !isAssetKind && !is3dKind) {
      skipped.push({ layerId: layerLabel, kind: layer?.kind ?? null, reason: 'EffectCraft adapter supports shape, text, image, video, 3d, camera and light layers; other kinds route to their own engines.' });
      continue;
    }
    if (is3dKind) {
      // 3D breadth (M1.4): primitives, cameras and lights. The comp upgrades
      // to the advanced3D renderer automatically when a 3dPrimitive lands.
      if (layer.kind === 'camera') {
        steps.push({ id: 'layer.newCamera', params: { name, ...(content?.preset ? { preset: content.preset } : {}) } });
        continue;
      }
      if (layer.kind === 'light') {
        steps.push({ id: 'layer.newLight', params: { name, kind: content?.kind || 'Point' } });
        continue;
      }
      const irPrimitive = content?.primitive;
      const primitive = IR_PRIMITIVE_TO_EFFECTCRAFT[irPrimitive];
      if (!primitive) {
        issues.push({ code: 'EFFECTCRAFT_PRIMITIVE_UNSUPPORTED', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'IR primitive "' + (irPrimitive ?? '(none)') + '" has no EffectCraft 3D primitive; use one of ' + Object.keys(IR_PRIMITIVE_TO_EFFECTCRAFT).join(', ') + '.' });
        continue;
      }
      const color = content?.material?.color || layer?.style?.color || project.brand?.colors?.accent || '#ffffff';
      if (!HEX.test(color)) { issues.push({ code: 'EFFECTCRAFT_COLOR_INVALID', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: '3D primitive baseColor must be #RRGGBB.' }); continue; }
      const position3d = content?.position ?? layer?.transform;
      steps.push({
        id: 'layer.new3dPrimitive',
        params: {
          kind: primitive,
          name,
          ...(primitive === 'cube' ? { width: Math.max(1, Math.round(Number(layer?.transform?.width) || 120)), height: Math.max(1, Math.round(Number(layer?.transform?.height) || 120)), depth: Math.max(1, Math.round(Number(content?.depth) || 120)) } : {}),
          ...(primitive === 'sphere' || primitive === 'torus' ? { radius: Math.max(1, Math.round(Number(content?.radius) || 60)) } : {}),
          ...(primitive === 'cone' || primitive === 'cylinder' ? { radius: Math.max(1, Math.round(Number(content?.radius) || 60)), height: Math.max(1, Math.round(Number(layer?.transform?.height) || 120)) } : {}),
          ...(primitive === 'plane' ? { width: Math.max(1, Math.round(Number(layer?.transform?.width) || 320)), height: Math.max(1, Math.round(Number(layer?.transform?.height) || 180)) } : {}),
          position: [Number(position3d?.x) || 0, Number(position3d?.y) || 0, Number(position3d?.z) || 0],
          baseColor: color,
          ...(Number.isFinite(Number(content?.metallic)) ? { metallic: Number(content.metallic) } : {}),
          ...(Number.isFinite(Number(content?.roughness)) ? { roughness: Number(content.roughness) } : {})
        }
      });
      steps.push(...presetKeyframes(preset, { x: Number(position3d?.x) || 0, y: Number(position3d?.y) || 0 }, layer, fps).map(frame => ({ id: 'prop.set', params: { layer: name, path: frame.path === 'transform/position' ? 'transform/position' : frame.path, value: Array.isArray(frame.value) && frame.value.length === 2 ? [...frame.value, 0] : frame.value, time: frame.time } })));
      steps.push(...effectStepsFor(layer?.effects, name, issues, scene.id, layerLabel));
      continue;
    }
    if (isAssetKind) {
      const asset = assetsById.get(layer?.assetId);
      if (!asset) { issues.push({ code: 'EFFECTCRAFT_ASSET_MISSING', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Asset layer ' + layerLabel + ' references asset ' + (layer?.assetId ?? '(none)') + ', which is missing from the Canonical Video IR.' }); continue; }
      if (!/^[a-f0-9]{64}$/i.test(asset?.sha256 || '')) { issues.push({ code: 'EFFECTCRAFT_ASSET_CHECKSUM_REQUIRED', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Asset ' + asset.id + ' needs a valid sha256 for the EffectCraft bridge.' }); continue; }
      if (typeof asset?.uri !== 'string' || !asset.uri.trim()) { issues.push({ code: 'EFFECTCRAFT_ASSET_URI_REQUIRED', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Asset ' + asset.id + ' has no uri.' }); continue; }
      const importIndex = assetLayers.length;
      // Editorial in-point: the IR layer's sourceInFrame (seconds in the
      // source) becomes a slip after the layer is trimmed to the scene length.
      const sourceInFrames = Number.isInteger(layer?.sourceInFrame) && layer.sourceInFrame >= 0 ? layer.sourceInFrame : 0;
      assetLayers.push({ importIndex, ref: 'asset:' + importIndex, clipId: layerLabel, assetId: asset.id, uri: asset.uri, sha256: asset.sha256.toLowerCase(), name, trimIn: secondsOf(sourceInFrames, fps), phaseTwoEffects: effectStepsFor(layer?.effects, name, issues, scene.id, layerLabel), box: { x: Number(layer?.transform?.x) || 0, y: Number(layer?.transform?.y) || 0, width: Math.max(1, Math.round(Number(layer?.transform?.width) || canvas.width)), height: Math.max(1, Math.round(Number(layer?.transform?.height) || canvas.height)) } });
      continue;
    }
    if (layer.kind === 'text') {
      const text = String(layer?.content?.text ?? '').trim();
      if (!text) { issues.push({ code: 'EFFECTCRAFT_TEXT_REQUIRED', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Text layers need non-empty content.text.' }); continue; }
      const color = layer?.style?.color;
      if (color && !HEX.test(color)) { issues.push({ code: 'EFFECTCRAFT_COLOR_INVALID', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Text color must be #RRGGBB.' }); continue; }
      const x = Number(layer?.transform?.x) || 0, y = Number(layer?.transform?.y) || 0;
      steps.push({ id: 'layer.newText', params: { text, name, position: [x, y], size: Math.max(1, Math.round(Number(layer?.typography?.sizePx) || 24)), ...(color ? { fill: color } : {}) } });
      steps.push(...presetKeyframes(preset, { x, y }, layer, fps).map(frame => ({ id: 'prop.set', params: { layer: name, path: frame.path, value: frame.value, time: frame.time } })));
      steps.push(...expressionStepsFor(layer?.expressions, name, issues, scene.id));
      steps.push(...effectStepsFor(layer?.effects, name, issues, scene.id, layerLabel));
    } else {
      const color = layer?.style?.backgroundColor;
      if (!HEX.test(color || '')) { issues.push({ code: 'EFFECTCRAFT_COLOR_INVALID', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Shape fills must be #RRGGBB.' }); continue; }
      const width = Math.max(1, Math.round(Number(layer?.transform?.width) || canvas.width));
      const height = Math.max(1, Math.round(Number(layer?.transform?.height) || canvas.height));
      const x = Number(layer?.transform?.x) || 0, y = Number(layer?.transform?.y) || 0;
      // Solids are positioned by their center in EffectCraft; keyframes must
      // target the same center so presets land on the IR transform.
      steps.push({ id: 'layer.newSolid', params: { name, color, width, height } });
      if (x !== 0 || y !== 0) steps.push({ id: 'prop.set', params: { layer: name, path: 'transform/position', value: [x + width / 2, y + height / 2, 0], time: 0 } });
      steps.push(...presetKeyframes(preset, { x: x + width / 2, y: y + height / 2 }, layer, fps).map(frame => ({ id: 'prop.set', params: { layer: name, path: frame.path, value: frame.value, time: frame.time } })));
      steps.push(...expressionStepsFor(layer?.expressions, name, issues, scene.id));
      steps.push(...effectStepsFor(layer?.effects, name, issues, scene.id, layerLabel));
    }
  }
  const blocking = issues.filter(item => item.severity === 'error');
  return {
    valid: blocking.length === 0,
    issues,
    scene: { id: scene.id, name: scene.name || scene.id, durationFrames: scene.durationFrames, fps, durationSeconds, width: canvas.width, height: canvas.height },
    steps,
    assetLayers,
    skipped,
    background
  };
}

function execute(executable, args, { cwd, timeoutMs = 600_000, signal } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('EffectCraft renderer requires a validated argument array.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-40000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error('EffectCraft render process failed (' + code + '). stderr: ' + stderr.slice(-2000) + ' stdout: ' + stdout.slice(-2000)));
    });
  });
}

export async function resolveEffectCraftCommand({ env = process.env, platform = process.platform } = {}) {
  for (const candidate of craftCommandCandidates({ app: 'effectcraft', env, platform })) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('effectcraft-cli was not found on this machine. Install EffectCraft (https://github.com/storytold/effectcraft) or pass effectcraftCommand explicitly.');
}

// EffectCraft's `run` prints each step's result as a pretty-printed JSON
// object (no step-id lines). Extract the JSON objects in output order so they
// can be zipped with the session's steps.
export function parseJsonObjects(text) {
  const objects = [];
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
    if (character === '{') { if (depth === 0) start = index; depth += 1; }
    else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = text.slice(start, index + 1);
        try { objects.push(JSON.parse(chunk)); } catch { /* non-JSON block: skip */ }
        start = -1;
      }
    }
  }
  return objects;
}

export async function renderEffectCraftScene(project, sceneId, options = {}) {
  const plan = planEffectCraftScene(project, sceneId);
  if (!plan.valid) throw new Error('Cannot render EffectCraft scene: ' + JSON.stringify(plan.issues));
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputRoot = inside(projectRoot, path.resolve(options.outputRoot || path.join(projectRoot, 'renders')), 'EffectCraft output directory');
  const engineRoot = inside(projectRoot, path.resolve(options.engineRoot || path.join(projectRoot, 'engines', 'effectcraft', sceneId)), 'EffectCraft engine directory');
  const sourceRoot = path.resolve(options.sourceRoot || path.dirname(path.resolve(options.projectFile || path.join(projectRoot, 'project.json'))));
  await mkdir(outputRoot, { recursive: true });
  // file.saveAs does not create parent directories.
  await mkdir(engineRoot, { recursive: true });
  // Checkpoint before writes (M1.4): an existing scene .ecproj is copied into
  // a bounded checkpoint directory before this run overwrites it, so a failed
  // build never destroys the last good state. Newest 3 are kept.
  const ecprojPath = path.join(engineRoot, 'scene.ecproj');
  const checkpointDir = path.join(engineRoot, 'checkpoints');
  if (existsSync(ecprojPath)) {
    await mkdir(checkpointDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(ecprojPath, path.join(checkpointDir, 'scene-' + stamp + '.ecproj'));
    const existing = (await readdir(checkpointDir)).filter(name => name.endsWith('.ecproj')).sort();
    for (const stale of existing.slice(0, Math.max(0, existing.length - 3))) {
      await rm(path.join(checkpointDir, stale), { force: true });
    }
  }
  const command = options.effectcraftCommand ?? await resolveEffectCraftCommand(options);
  const spec = plan.scene;
  const sourceSha256 = createHash('sha256').update(JSON.stringify(project)).digest('hex');

  // Resolve asset layers: workspace-contained paths, verified against the IR
  // checksum, dimensions probed for scale-to-box. Fails before any session.
  const resolvedAssets = [];
  for (const assetLayer of plan.assetLayers) {
    const uri = String(assetLayer.uri);
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error('EffectCraft asset ' + assetLayer.assetId + ' uses a remote scheme; only project-relative or file: paths are supported.');
    const candidate = path.resolve(sourceRoot, uri);
    const relative = path.relative(sourceRoot, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('EffectCraft asset ' + assetLayer.assetId + ' escapes the project source root.');
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('EffectCraft asset ' + assetLayer.assetId + ' does not resolve to a file: ' + uri);
    const actualSha256 = createHash('sha256').update(await readFile(candidate)).digest('hex');
    if (actualSha256 !== assetLayer.sha256) throw new Error('EffectCraft asset ' + assetLayer.assetId + ' sha256 mismatch: the on-disk file does not match the Canonical Video IR.');
    const media = await probeMedia(candidate, { signal: options.signal });
    if (!(media.width > 0) || !(media.height > 0)) throw new Error('EffectCraft asset ' + assetLayer.assetId + ' has no probeable dimensions.');
    resolvedAssets.push({ ...assetLayer, path: candidate, itemWidth: media.width, itemHeight: media.height });
  }

  // Session 1: build the comp (shape/text layers) and import + save in the
  // SAME session — a saveAs from a separate session persists an empty project.
  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-effectcraft-'));
  try {
    const sessionOne = [
      ...plan.steps,
      ...(resolvedAssets.length ? [{ id: 'file.import', params: { paths: resolvedAssets.map(asset => asset.path) } }] : []),
      { id: 'file.saveAs', params: { path: path.join(engineRoot, 'scene.ecproj') } }
    ];
    const stepsFile = path.join(phaseRoot, 'build.jsonl');
    await writeFile(stepsFile, sessionOne.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
    const buildOut = await execute(command, ['run', '--commands', stepsFile], { cwd: phaseRoot, timeoutMs: options.timeoutMs || 600_000, signal: options.signal });
    const projectStat = await stat(ecprojPath);
    if (!projectStat.isFile() || projectStat.size === 0) throw new Error('EffectCraft did not produce the scene .ecproj.');

    // Session 2 (only when asset layers exist): reopen the saved project,
    // resolve each footage item id from the import result, place and scale it
    // to the IR box (EffectCraft positions footage layers by center).
    if (resolvedAssets.length) {
      // Results print as one JSON object per step, in step order.
      const results = parseJsonObjects(buildOut.stdout);
      const importStepIndex = sessionOne.findIndex(step => step.id === 'file.import');
      const importResult = results[importStepIndex];
      const importedItems = importResult?.items;
      if (!Array.isArray(importedItems) || importedItems.length !== resolvedAssets.length) {
        throw new Error('EffectCraft imported ' + (importedItems?.length ?? 0) + ' asset items but ' + resolvedAssets.length + ' were requested; aborting. Output: ' + buildOut.stdout.slice(-600));
      }
      const sessionTwo = [
        { id: 'comp.open', params: { comp: sceneId } },
        ...resolvedAssets.map(asset => {
          const scaleX = Math.round(asset.box.width / asset.itemWidth * 10000) / 100;
          const scaleY = Math.round(asset.box.height / asset.itemHeight * 10000) / 100;
          // addItem selects the new layer, so the immediate rename targets it;
          // afterwards every prop.set addresses the deterministic MS- name.
          // Footage trims: the item is placed at full source length, so trim
          // the layer out to the scene length first — then slip to the
          // editorial in-point (slip clamps at the source bounds, and an
          // out point equal to the full source length would clamp to zero).
          const stepsForAsset = [
            { id: 'layer.addItem', params: { item: importedItems[asset.importIndex], time: 0, position: [asset.box.x + asset.box.width / 2, asset.box.y + asset.box.height / 2] } },
            { id: 'layer.rename', params: { name: asset.name } },
            { id: 'layer.timing', params: { layers: [asset.name], op: 'trimOutToTime', out: spec.durationSeconds } }
          ];
          if (asset.trimIn > 0) stepsForAsset.push({ id: 'layer.slip', params: { layers: [asset.name], delta: asset.trimIn } });
          stepsForAsset.push({ id: 'prop.set', params: { layer: asset.name, path: 'transform/scale', value: [scaleX, scaleY, 100], time: 0 } });
          stepsForAsset.push(...(asset.phaseTwoEffects || []));
          return stepsForAsset;
        }).flat(),
        { id: 'file.saveAs', params: { path: ecprojPath } }
      ];
      const sessionTwoFile = path.join(phaseRoot, 'assets.jsonl');
      await writeFile(sessionTwoFile, sessionTwo.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
      await execute(command, ['--project', ecprojPath, 'run', '--commands', sessionTwoFile], { cwd: phaseRoot, timeoutMs: options.timeoutMs || 600_000, signal: options.signal });
    }

    // Session 3: render the saved comp to an MP4 at the IR contract.
    const fps = spec.fps;
    const output = path.join(outputRoot, project.project.id + '-' + sceneId + '-effectcraft-' + (options.quality || 'draft') + '.mp4');
    await execute(command, ['--project', ecprojPath, 'render', '--comp', sceneId, '--out', output, '--fps', String(fps)], { cwd: phaseRoot, timeoutMs: options.timeoutMs || 600_000, signal: options.signal });
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('EffectCraft output artifact is empty or missing.');
    const media = await probeMedia(output, { signal: options.signal });
    const verification = inspectMedia(media, { width: spec.width, height: spec.height, fps, durationSeconds: spec.durationSeconds, durationToleranceSeconds: 1 / fps });
    if (!verification.passed) throw new Error('EffectCraft output failed independent FFprobe verification: ' + JSON.stringify(verification.failures));
    const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
    const receipt = {
      schemaVersion: '1.0.0', engine: 'effectcraft', projectId: project.project.id, projectRevision: project.project.revision || 1,
      sceneId, sceneName: spec.sceneName, sourceSha256,
      artifact: { path: output, sha256: outputSha256, byteSize: outputStat.size, container: 'mp4', codec: media.videoCodec, width: media.width, height: media.height, frameRate: project.project.frameRate, durationFrames: spec.durationFrames, durationSeconds: media.durationSeconds, colorSpace: 'sRGB', alpha: false, audio: { present: media.hasAudio, codec: media.audioCodec || null } },
      verification, checks: [{ name: 'ffprobe-verify', exitCode: 0 }], skippedLayers: plan.skipped, planIssues: plan.issues,
      assets: resolvedAssets.map(asset => ({ assetId: asset.assetId, clipId: asset.clipId, path: asset.path, item: { width: asset.itemWidth, height: asset.itemHeight }, box: asset.box })),
      ecprojPath, effectcraftVersion: null, verified: true, completedAt: new Date().toISOString()
    };
    await mkdir(engineRoot, { recursive: true });
    await writeFile(output + '.effectcraft.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    return receipt;
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

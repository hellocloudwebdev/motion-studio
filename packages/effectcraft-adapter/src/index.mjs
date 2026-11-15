import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

// Pure, deterministic planner: Canonical Video IR scene -> EffectCraft engine
// command steps. Unsupported layer kinds are reported, never silently
// dropped. The plan only uses live-verified command ids and property paths.
export function planEffectCraftScene(project, sceneId) {
  const validation = validateProject(project);
  if (!validation.valid) return { valid: false, issues: validation.issues };
  const scene = (project.scenes || []).find(item => item?.id === sceneId);
  if (!scene) return { valid: false, issues: [{ code: 'SCENE_NOT_FOUND', sceneId }] };
  const issues = [];
  const skipped = [];
  const steps = [];
  const fps = project.project.frameRate.numerator / project.project.frameRate.denominator;
  const durationSeconds = secondsOf(scene.durationFrames, fps);
  const canvas = project.project.canvas;
  const background = rgbOf(project.brand?.colors?.background) || [0.06, 0.06, 0.07];
  steps.push({ id: 'comp.new', params: { name: scene.id, width: canvas.width, height: canvas.height, frameRate: fps, duration: durationSeconds, background: project.brand?.colors?.background || '#101010' } });
  let layerCounter = 0;
  for (const layer of Array.isArray(scene.layers) ? scene.layers : []) {
    const layerLabel = layer?.id || 'layer-' + (++layerCounter);
    if (!SUPPORTED_LAYER_KINDS.has(layer?.kind)) {
      skipped.push({ layerId: layerLabel, kind: layer?.kind ?? null, reason: 'EffectCraft adapter v1 supports shape and text layers only; asset and 3D layers route to their own engines.' });
      continue;
    }
    const name = 'MS-' + String(layerLabel).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    const preset = layer?.motion?.preset;
    if (layer.kind === 'text') {
      const text = String(layer?.content?.text ?? '').trim();
      if (!text) { issues.push({ code: 'EFFECTCRAFT_TEXT_REQUIRED', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Text layers need non-empty content.text.' }); continue; }
      const color = layer?.style?.color;
      if (color && !HEX.test(color)) { issues.push({ code: 'EFFECTCRAFT_COLOR_INVALID', severity: 'error', sceneId: scene.id, layerId: layerLabel, message: 'Text color must be #RRGGBB.' }); continue; }
      const x = Number(layer?.transform?.x) || 0, y = Number(layer?.transform?.y) || 0;
      steps.push({ id: 'layer.newText', params: { text, name, position: [x, y], size: Math.max(1, Math.round(Number(layer?.typography?.sizePx) || 24)), ...(color ? { fill: color } : {}) } });
      steps.push(...presetKeyframes(preset, { x, y }, layer, fps).map(frame => ({ id: 'prop.set', params: { layer: name, path: frame.path, value: frame.value, time: frame.time } })));
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
    }
  }
  const blocking = issues.filter(item => item.severity === 'error');
  return {
    valid: blocking.length === 0,
    issues,
    scene: { id: scene.id, name: scene.name || scene.id, durationFrames: scene.durationFrames, fps, durationSeconds, width: canvas.width, height: canvas.height },
    steps,
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

export async function renderEffectCraftScene(project, sceneId, options = {}) {
  const plan = planEffectCraftScene(project, sceneId);
  if (!plan.valid) throw new Error('Cannot render EffectCraft scene: ' + JSON.stringify(plan.issues));
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputRoot = inside(projectRoot, path.resolve(options.outputRoot || path.join(projectRoot, 'renders')), 'EffectCraft output directory');
  const engineRoot = inside(projectRoot, path.resolve(options.engineRoot || path.join(projectRoot, 'engines', 'effectcraft', sceneId)), 'EffectCraft engine directory');
  await mkdir(outputRoot, { recursive: true });
  // file.saveAs does not create parent directories.
  await mkdir(engineRoot, { recursive: true });
  const command = options.effectcraftCommand ?? await resolveEffectCraftCommand(options);
  const spec = plan.scene;
  const sourceSha256 = createHash('sha256').update(JSON.stringify(project)).digest('hex');

  // Session 1: build the comp and save the .ecproj into the workspace.
  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-effectcraft-'));
  try {
    const buildSteps = [...plan.steps, { id: 'file.saveAs', params: { path: path.join(engineRoot, 'scene.ecproj') } }];
    const stepsFile = path.join(phaseRoot, 'build.jsonl');
    await writeFile(stepsFile, buildSteps.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
    await execute(command, ['run', '--commands', stepsFile], { cwd: phaseRoot, timeoutMs: options.timeoutMs || 600_000, signal: options.signal });
    const ecprojPath = path.join(engineRoot, 'scene.ecproj');
    const projectStat = await stat(ecprojPath);
    if (!projectStat.isFile() || projectStat.size === 0) throw new Error('EffectCraft did not produce the scene .ecproj.');

    // Session 2: render the saved comp to an MP4 at the IR contract.
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
      ecprojPath, effectcraftVersion: null, verified: true, completedAt: new Date().toISOString()
    };
    await mkdir(engineRoot, { recursive: true });
    await writeFile(output + '.effectcraft.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    return receipt;
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

import { createHash } from 'node:crypto';
import { validateProject } from './validate-project.mjs';
import { calculateTypeScale, estimateTextFit } from './typography.mjs';

// Repair-executor patch model: QA defects are classified against an exhaustive
// code -> policy registry (AUTO / COND / REPORT), converted into bounded patch
// operations, then applied to a clone of the Canonical Video IR under a
// compare-and-swap on the IR hash plus a no-new-issues validation gate.

export class PatchError extends Error {
  constructor(message, { code = 'PATCH_FAILED', details = null } = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    if (details !== null) this.details = details;
  }
}

// Canonical IR hash: must stay identical to the render manifest's
// projectIrSha256 (JSON.stringify of the IR, hashed with SHA-256).
export function projectIrSha256(project) {
  return createHash('sha256').update(JSON.stringify(project)).digest('hex');
}

// Enumerated values the HyperFrames adapter actually implements (see the
// adapter's data-motion branches and its allowed ease list).
export const MOTION_PRESETS = new Set(['none', 'fade', 'fade-up', 'slide-up', 'float', 'slide-left', 'slide-right', 'zoom', 'rotate']);
export const MOTION_EASINGS = new Set(['none', 'power1.out', 'power2.out', 'power3.out', 'power4.out', 'back.out(1.7)', 'sine.out', 'circ.out']);

export const OP_TYPES = new Set(['set_typography', 'set_transform', 'set_motion', 'set_timing', 'rebind_asset', 'set_audio_cue']);

const TYPOGRAPHY_FIELDS = new Set(['family', 'sizePx', 'weight', 'lineHeight', 'tracking', 'alignment', 'maxLines', 'safeArea']);
const TRANSFORM_FIELDS = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale']);
const MOTION_FIELDS = new Set(['preset', 'durationFrames', 'delayFrames', 'easing']);
const TIMING_FIELDS = new Set(['startFrame', 'durationFrames', 'totalDurationFrames']);
const AUDIO_CUE_FIELDS = new Set(['assetId', 'offsetFrames', 'durationFrames', 'volume', 'fadeInFrames', 'fadeOutFrames', 'duckAgainstNarration']);
const VALUE_FIELDS = {
  set_typography: TYPOGRAPHY_FIELDS,
  set_transform: TRANSFORM_FIELDS,
  set_motion: MOTION_FIELDS,
  set_timing: TIMING_FIELDS,
  set_audio_cue: AUDIO_CUE_FIELDS,
  rebind_asset: new Set(['assetId'])
};
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const ASSET_KINDS = new Set(['image', 'video', 'audio']);
const LAYER_OP_TYPES = new Set(['set_typography', 'set_transform', 'set_motion', 'rebind_asset']);
const MIN_TYPOGRAPHY_SIZE_PX = 18;
const MAX_REPAIR_CYCLES = 3;
// Cumulative volume-adjustment budget for a whole repair run (design §3.3):
// every applied set_audio_cue volume op spends |gainDb| against this budget.
export const GAIN_BUDGET_DB = 6;
// Edge tolerance for black-frame attribution (mirrors the detector's 0.1 s clip
// boundary rule) and the adjacency window for cue-placement silence gaps.
const BLACK_EDGE_TOLERANCE_SECONDS = 0.1;
const CUE_ADJACENCY_TOLERANCE_FRAMES_RATIO = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const issue = (code, path, message, severity = 'error') => ({ code, path, message, severity });
const isHex64 = value => typeof value === 'string' && SHA256_PATTERN.test(value);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const positiveInteger = value => Number.isInteger(value) && value > 0;
const nonNegativeInteger = value => Number.isInteger(value) && value >= 0;

function brandFonts(project) {
  const fonts = project?.brand?.fonts;
  return fonts && typeof fonts === 'object' && !Array.isArray(fonts) ? fonts : null;
}

function declaredFontFamily(project) {
  const fonts = brandFonts(project);
  return fonts?.display || fonts?.body || null;
}

function textOf(layer) {
  return String(layer?.content?.text ?? layer?.content ?? layer?.text ?? '');
}

function boxOf(layer) {
  const transform = layer?.transform && typeof layer.transform === 'object' ? layer.transform : {};
  const layout = layer?.layout && typeof layer.layout === 'object' ? layer.layout : {};
  return {
    x: Number(transform.x ?? layout.x ?? 0),
    y: Number(transform.y ?? layout.y ?? 0),
    width: Number(transform.width ?? layout.width ?? 800),
    height: Number(transform.height ?? layout.height ?? 180)
  };
}

function safeAreaBounds(project) {
  const canvas = project?.project?.canvas;
  if (!canvas || typeof canvas !== 'object' || !Number.isFinite(Number(canvas.width)) || !Number.isFinite(Number(canvas.height))) return null;
  const marginX = Number(canvas.width) * Math.max(0, Number(canvas.safeAreaPercent ?? 5)) / 100;
  const marginY = Number(canvas.height) * Math.max(0, Number(canvas.safeAreaPercent ?? 5)) / 100;
  return { width: Number(canvas.width), height: Number(canvas.height), marginX, marginY };
}

function assetsById(project) {
  return new Map((Array.isArray(project?.assets) ? project.assets : []).filter(asset => asset && typeof asset.id === 'string').map(asset => [asset.id, asset]));
}

function audioAssetIds(project) {
  return (Array.isArray(project?.assets) ? project.assets : []).filter(asset => asset && asset.id && asset.kind === 'audio').map(asset => asset.id);
}

// rebind_asset can only target an already-declared, same-kind asset. Assets
// carrying a sha256 must additionally be verified on disk (the repair executor
// passes the verified id set); hashed assets cannot be invented from here.
function rebindCandidateFor(layer, { project, verifiedAssetIds }, currentAssetId) {
  return [...assetsById(project).values()].find(asset =>
    asset.kind === layer.kind && asset.id !== currentAssetId && (!asset.sha256 || (verifiedAssetIds instanceof Set && verifiedAssetIds.has(asset.id)))
  ) || null;
}

function scopeSceneIds(defect, project) {
  const sceneIds = (Array.isArray(project?.scenes) ? project.scenes : []).map(scene => scene?.id).filter(id => typeof id === 'string' && id);
  if (defect?.sceneId && defect.sceneId !== 'project' && sceneIds.includes(defect.sceneId)) return [defect.sceneId];
  return sceneIds;
}

function layersInScope(defect, project, predicate) {
  const hits = [];
  for (const sceneId of scopeSceneIds(defect, project)) {
    const scene = (project.scenes || []).find(item => item?.id === sceneId);
    for (const layer of Array.isArray(scene?.layers) ? scene.layers : []) if (layer && predicate(layer)) hits.push({ scene, layer });
  }
  return hits;
}

// eachAudioCue yields every cue with its patch target, the scene-LOCAL
// container end for clamping ops, and the ABSOLUTE base frame of its container
// (scene start, or 0 for project tracks) — same convention as
// delivery-manager's audio-inputs.mjs. Scene cue offsets are scene-local while
// media-defect timeRangeFrames are project-timeline, so range comparisons must
// go through baseFrame + offset.
function eachAudioCue(project) {
  const cues = [];
  let nextSceneFrame = 0;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    const baseFrame = Number.isInteger(scene?.startFrame) && scene.startFrame >= 0 ? scene.startFrame : nextSceneFrame;
    if (positiveInteger(scene?.durationFrames)) nextSceneFrame = Math.max(nextSceneFrame, baseFrame + scene.durationFrames);
    (Array.isArray(scene?.audioCues) ? scene.audioCues : []).forEach((cue, index) => {
      if (cue && typeof cue === 'object') cues.push({ cue, target: { sceneId: scene.id, index }, baseFrame, containerEndFrame: positiveInteger(scene.durationFrames) ? scene.durationFrames : null });
    });
  }
  (Array.isArray(project?.audio?.tracks) ? project.audio.tracks : []).forEach((cue, index) => {
    if (cue && typeof cue === 'object') cues.push({ cue, target: { index }, baseFrame: 0, containerEndFrame: positiveInteger(project?.project?.totalDurationFrames) ? project.project.totalDurationFrames : null });
  });
  return cues;
}

// Audible start on the absolute project timeline (offsetFrames ?? startFrame,
// same resolution as the validator and audio-inputs.mjs).
function cueAudibleStart(item) {
  const offset = item.cue.offsetFrames ?? item.cue.startFrame ?? 0;
  return item.baseFrame + (nonNegativeInteger(offset) ? offset : 0);
}

function cueOverlapsRange(item, range) {
  if (!range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)) return true;
  const start = cueAudibleStart(item);
  const end = positiveInteger(item.cue.durationFrames) ? start + item.cue.durationFrames : Number.POSITIVE_INFINITY;
  return start < range.endFrame && range.startFrame < end;
}

function clampTextLayerIntoSafeArea(defect, project) {
  const bounds = safeAreaBounds(project);
  if (!bounds) return [];
  const ops = [];
  for (const { scene, layer } of layersInScope(defect, project, layer => layer.kind === 'text')) {
    const box = boxOf(layer);
    const maxX = bounds.width - bounds.marginX - box.width, maxY = bounds.height - bounds.marginY - box.height;
    if (maxX < bounds.marginX || maxY < bounds.marginY) continue;
    const clampedX = Math.min(Math.max(box.x, bounds.marginX), maxX);
    const clampedY = Math.min(Math.max(box.y, bounds.marginY), maxY);
    if (clampedX === box.x && clampedY === box.y) continue;
    ops.push({ type: 'set_transform', target: { sceneId: scene.id, layerId: layer.id }, value: { x: clampedX, y: clampedY } });
  }
  return ops;
}

function textLayersOutsideSafeArea(defect, project) {
  const bounds = safeAreaBounds(project);
  if (!bounds) return [];
  const hits = [];
  for (const { scene, layer } of layersInScope(defect, project, layer => layer.kind === 'text')) {
    const box = boxOf(layer);
    if (box.x < bounds.marginX || box.y < bounds.marginY || box.x + box.width > bounds.width - bounds.marginX || box.y + box.height > bounds.height - bounds.marginY) hits.push({ scene, layer, box, bounds });
  }
  return hits;
}

function fpsOf(project) {
  const rate = project?.project?.frameRate;
  const numerator = Number(rate?.numerator), denominator = Number(rate?.denominator);
  return numerator > 0 && denominator > 0 ? numerator / denominator : 0;
}

// Scene starts are absolute: a declared startFrame, otherwise the cumulative
// sum of previous durations (same convention as render-manager's timeline).
function sceneStartFrame(project, sceneId) {
  let nextStart = 0;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    const durationFrames = Number(scene?.durationFrames);
    const startFrame = Number.isInteger(scene?.startFrame) && scene.startFrame >= 0 ? scene.startFrame : nextStart;
    if (scene?.id === sceneId) return Number.isInteger(durationFrames) && durationFrames > 0 ? startFrame : null;
    nextStart = Math.max(nextStart, startFrame + (Number.isInteger(durationFrames) ? durationFrames : 0));
  }
  return null;
}

function owningScene(defect, project) {
  const sceneId = defect?.sceneId;
  if (typeof sceneId !== 'string' || !sceneId || sceneId === 'project') return null;
  return (project?.scenes || []).find(scene => scene?.id === sceneId) || null;
}

function typeScaleCaptionSize(project) {
  const canvas = project?.project?.canvas;
  if (!canvas || !Number.isInteger(Number(canvas.width)) || !Number.isInteger(Number(canvas.height))) return MIN_TYPOGRAPHY_SIZE_PX;
  return Math.max(MIN_TYPOGRAPHY_SIZE_PX, Number(calculateTypeScale({ width: Number(canvas.width), height: Number(canvas.height) }).sizesPx.caption));
}

function fitAtSize(layer, box, sizePx) {
  return estimateTextFit({
    text: textOf(layer), fontSizePx: sizePx, boxWidthPx: box.width, boxHeightPx: box.height,
    lineHeight: Number(layer.typography?.lineHeight || 1.08), maxLines: Number(layer.typography?.maxLines || Infinity)
  });
}

// Design §3.3 priority for overflow: (1) enlarge the box inside the safe area,
// (2) shrink sizePx toward the 18 px floor, (3) leave it REPORTed — text
// content itself is never patched.
function overflowRepairOps(scene, layer, project) {
  const box = boxOf(layer);
  const sizePx = Number(layer.typography?.sizePx);
  if (!(sizePx > 0) || !(box.width > 0) || !(box.height > 0)) return [];
  const fit = fitAtSize(layer, box, sizePx);
  if (fit.fits) return [];
  const bounds = safeAreaBounds(project);
  if (bounds) {
    const maxHeight = Math.floor(bounds.height - bounds.marginY - box.y);
    const enlargedHeight = Math.min(fit.requiredHeightPx, maxHeight);
    if (enlargedHeight > box.height && fitAtSize(layer, { ...box, height: enlargedHeight }, sizePx).fits) {
      return [{ type: 'set_transform', target: { sceneId: scene.id, layerId: layer.id }, value: { height: enlargedHeight } }];
    }
  }
  const shrunk = Math.floor(sizePx * box.height / fit.requiredHeightPx);
  if (shrunk >= MIN_TYPOGRAPHY_SIZE_PX && shrunk < sizePx) {
    return [{ type: 'set_typography', target: { sceneId: scene.id, layerId: layer.id }, value: { sizePx: shrunk } }];
  }
  return [];
}

// Raising sub-floor text to the target size may overflow its box; per design
// §3.3 the typography op is then paired with a safe-area box enlargement, and
// when neither fits the defect escalates (no ops).
function textTooSmallOps(scene, layer, project) {
  const targetSizePx = Math.max(MIN_TYPOGRAPHY_SIZE_PX, typeScaleCaptionSize(project));
  const typographyOp = { type: 'set_typography', target: { sceneId: scene.id, layerId: layer.id }, value: { sizePx: targetSizePx } };
  const box = boxOf(layer);
  if (!(box.width > 0) || !(box.height > 0)) return [typographyOp];
  if (fitAtSize(layer, box, targetSizePx).fits) return [typographyOp];
  const bounds = safeAreaBounds(project);
  if (!bounds) return [];
  const enlargedHeight = Math.min(fitAtSize(layer, box, targetSizePx).requiredHeightPx, Math.floor(bounds.height - bounds.marginY - box.y));
  if (enlargedHeight > box.height && fitAtSize(layer, { ...box, height: enlargedHeight }, targetSizePx).fits) {
    return [typographyOp, { type: 'set_transform', target: { sceneId: scene.id, layerId: layer.id }, value: { height: enlargedHeight } }];
  }
  return [];
}

// Static content layers own frozen-frame holds: text, image and chart layers
// with no motion or an explicit 'none' preset. Full-canvas backgrounds and
// layers that already move are never patched.
function staticContentLayers(scene) {
  return (Array.isArray(scene?.layers) ? scene.layers : []).filter(layer => layer && ['text', 'image', 'chart'].includes(layer.kind) && (!layer.motion || layer.motion?.preset === 'none'));
}

function frozenFrameMotionOps(defect, project) {
  const scene = owningScene(defect, project);
  if (!scene || !positiveInteger(scene.durationFrames)) return [];
  const candidates = staticContentLayers(scene);
  // Ambiguous ownership (zero or several static content layers) stays REPORTed.
  if (candidates.length !== 1) return [];
  return [{ type: 'set_motion', target: { sceneId: scene.id, layerId: candidates[0].id }, value: { preset: 'float', durationFrames: scene.durationFrames, delayFrames: 0, easing: 'sine.out' } }];
}

function layerCoverageIntervals(scene) {
  return (Array.isArray(scene?.layers) ? scene.layers : []).filter(layer => layer).map(layer => {
    const start = Number.isInteger(layer.startFrame) && layer.startFrame >= 0 ? layer.startFrame : 0;
    const duration = Number.isInteger(layer.durationFrames) && layer.durationFrames > 0 ? layer.durationFrames : Number(scene.durationFrames);
    return { layer, start, end: start + duration };
  }).filter(item => item.end > item.start);
}

// Interior black frames are attributable to a coverage gap when the owning
// scene's layer timings leave the sampled range uncovered and exactly one
// layer borders the gap: extend its timing over the gap, or pull a later
// layer's start earlier. Black frames at clip edges may be intentional fades.
function blackFrameCoverOps(defect, project) {
  const range = defect?.timeRangeFrames;
  if (!range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.endFrame <= range.startFrame) return [];
  const scene = owningScene(defect, project);
  if (!scene || !positiveInteger(scene.durationFrames)) return [];
  const totalFrames = Number(project?.project?.totalDurationFrames);
  const fps = fpsOf(project);
  const tolerance = fps > 0 ? Math.ceil(BLACK_EDGE_TOLERANCE_SECONDS * fps) : 0;
  const total = Number.isInteger(totalFrames) && totalFrames > 0 ? totalFrames : sceneStartFrame(project, scene.id) + scene.durationFrames;
  if (range.startFrame <= tolerance || range.endFrame >= total - tolerance) return [];
  const sceneStart = sceneStartFrame(project, scene.id);
  if (sceneStart === null) return [];
  const localStart = range.startFrame - sceneStart, localEnd = range.endFrame - sceneStart;
  if (localStart < 0 || localEnd > scene.durationFrames) return [];
  const intervals = layerCoverageIntervals(scene);
  const covered = intervals.some(item => item.start <= localStart && localEnd <= item.end);
  if (covered) return [];
  const before = intervals.filter(item => item.end <= localStart).sort((a, b) => b.end - a.end)[0] || null;
  const after = intervals.filter(item => item.start >= localEnd).sort((a, b) => a.start - b.start)[0] || null;
  if (before && after) return [];
  if (before) {
    const extensionEnd = Math.min(localEnd, scene.durationFrames);
    if (extensionEnd - before.start < 1 || extensionEnd <= before.end) return [];
    return [{ type: 'set_timing', target: { sceneId: scene.id, layerId: before.layer.id }, value: { durationFrames: extensionEnd - before.start } }];
  }
  if (after) {
    if (after.start - localStart < 1 || localEnd > after.end) return [];
    return [{ type: 'set_timing', target: { sceneId: scene.id, layerId: after.layer.id }, value: { startFrame: localStart } }];
  }
  return [];
}

// Silence attributable to cue placement: close the gap by extending the
// immediately preceding narration cue over it, or by shifting the following
// one earlier, without leaving the containing timeline or overlapping a
// neighbouring cue. Adjacency is measured on the absolute project timeline
// (defect ranges are project-timeline); emitted offset/duration values stay
// scene-local. Unattributable gaps are treated as reviewed pauses.
function audioGapClosureOps(defect, project) {
  const range = defect?.timeRangeFrames;
  if (!range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.endFrame <= range.startFrame) return [];
  const cues = eachAudioCue(project).filter(({ cue }) => (cue.kind ?? cue.role ?? 'narration') === 'narration' && positiveInteger(cue.durationFrames));
  const audibleEnd = item => cueAudibleStart(item) + item.cue.durationFrames;
  const fps = fpsOf(project);
  const tolerance = Math.max(1, Math.ceil(fps * CUE_ADJACENCY_TOLERANCE_FRAMES_RATIO));
  const overlaps = (item, start, end) => cueAudibleStart(item) < end && start < audibleEnd(item);
  const preceding = cues
    .filter(item => audibleEnd(item) <= range.startFrame && range.startFrame - audibleEnd(item) <= tolerance)
    .sort((a, b) => audibleEnd(b) - audibleEnd(a))[0] || null;
  if (preceding && !cues.some(item => item !== preceding && overlaps(item, audibleEnd(preceding), range.endFrame))) {
    const containerEnd = preceding.containerEndFrame;
    const extended = range.endFrame - cueAudibleStart(preceding);
    if (extended > preceding.cue.durationFrames && (!positiveInteger(containerEnd) || (cueAudibleStart(preceding) - preceding.baseFrame) + extended <= containerEnd)) {
      return [{ type: 'set_audio_cue', target: preceding.target, value: { durationFrames: extended } }];
    }
  }
  const following = cues
    .filter(item => cueAudibleStart(item) >= range.endFrame && cueAudibleStart(item) - range.endFrame <= tolerance)
    .sort((a, b) => cueAudibleStart(a) - cueAudibleStart(b))[0] || null;
  if (following && !cues.some(item => item !== following && overlaps(item, range.startFrame, cueAudibleStart(following)))) {
    const containerEnd = following.containerEndFrame;
    const shiftedOffset = range.startFrame - following.baseFrame;
    const shiftedDuration = following.cue.durationFrames + (cueAudibleStart(following) - range.startFrame);
    if (shiftedDuration > following.cue.durationFrames && nonNegativeInteger(shiftedOffset) && (!positiveInteger(containerEnd) || shiftedOffset + shiftedDuration <= containerEnd)) {
      return [{ type: 'set_audio_cue', target: following.target, value: { offsetFrames: shiftedOffset, durationFrames: shiftedDuration } }];
    }
  }
  return [];
}

// Applied volume deltas are recorded as op.gainDb on each set_audio_cue op;
// the ±6 dB budget is recounted from the repair ledger of the current run so
// the limit survives crashes without any state outside the Canonical IR.
export function computeRunGainBudgetUsed(project, runId) {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('A non-empty runId is required to compute the gain budget.');
  const history = Array.isArray(project?.qa?.repairHistory) ? project.qa.repairHistory : [];
  let usedDb = 0;
  for (const entry of history) {
    if (!entry || entry.runId !== runId || !Array.isArray(entry.patch?.ops)) continue;
    for (const op of entry.patch.ops) {
      if (op?.type === 'set_audio_cue' && Number.isFinite(Number(op.gainDb))) usedDb += Math.abs(Number(op.gainDb));
    }
  }
  return Math.round(usedDb * 100) / 100;
}

function audioGainOps(defect, context) {
  const value = Number(defect?.value), threshold = Number(defect?.threshold);
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return [];
  // TOO_QUIET gains; TOO_LOUD and TRUE_PEAK reduce — true-peak never applies
  // makeup gain (design §3.3).
  const reductionOnly = defect.code !== 'AUDIO_PROGRAM_TOO_QUIET';
  const requiredDb = reductionOnly ? value - threshold : threshold - value;
  if (!(requiredDb > 0)) return [];
  // The budget is threaded through classification: every emitted op spends its
  // |gainDb| against the shared running total (matching the ledger recount),
  // and a second gain on the same cue merges into the pending op so the
  // recorded gainDb always equals the applied net gain (applyOp merges
  // same-cue values by assignment, which would otherwise drop earlier gains).
  const budget = context.gainBudget && typeof context.gainBudget === 'object'
    ? context.gainBudget
    : { limitDb: GAIN_BUDGET_DB, usedDb: 0, cueGains: new Map() };
  const signedDb = applied => (reductionOnly ? -applied : applied);
  const ops = [];
  for (const item of eachAudioCue(context.project)) {
    if (!cueOverlapsRange(item, defect.timeRangeFrames)) continue;
    const remainingDb = Math.round((budget.limitDb - budget.usedDb) * 100) / 100;
    const appliedDb = Math.round(Math.min(requiredDb, Math.max(0, remainingDb)) * 100) / 100;
    if (!(appliedDb > 0)) continue;
    const key = JSON.stringify(item.target);
    const pending = budget.cueGains instanceof Map ? budget.cueGains.get(key) : null;
    if (pending) {
      const mergedDb = Math.round((pending.signedDb + signedDb(appliedDb)) * 100) / 100;
      const mergedVolume = Math.round(pending.baseVolume * Math.pow(10, mergedDb / 20) * 100) / 100;
      if (!(mergedVolume > 0) || mergedVolume > 4 || mergedVolume === pending.op.value.volume) continue;
      pending.op.value.volume = mergedVolume;
      pending.op.gainDb = mergedDb;
      pending.signedDb = mergedDb;
    } else {
      const current = finiteNumber(item.cue.volume) ? item.cue.volume : 1;
      const next = Math.round(current * Math.pow(10, signedDb(appliedDb) / 20) * 100) / 100;
      if (next <= 0 || next > 4 || next === current) continue;
      const op = { type: 'set_audio_cue', target: item.target, value: { volume: next }, gainDb: signedDb(appliedDb) };
      ops.push(op);
      if (budget.cueGains instanceof Map) budget.cueGains.set(key, { op, baseVolume: current, signedDb: signedDb(appliedDb) });
    }
    budget.usedDb = Math.round((budget.usedDb + appliedDb) * 100) / 100;
  }
  return ops;
}

// Every defect code the repository emits maps to exactly one policy:
// AUTO patches unconditionally, COND patches only when its builder can derive a
// safe value from the project, REPORT is escalate-only. BLOCKING_<CODE>
// compiler warnings resolve to the entry of their underlying code.
export const DEFECT_REPAIR_REGISTRY = {
  FONT_UNSPECIFIED: {
    policy: 'AUTO', op: 'set_typography', reason: 'Missing font families are filled from the declared brand display font.',
    build(defect, { project }) {
      const family = declaredFontFamily(project);
      if (!family) return [];
      return layersInScope(defect, project, layer => layer.kind === 'text' && !(layer.typography && typeof layer.typography.family === 'string' && layer.typography.family.trim()))
        .map(({ scene, layer }) => ({ type: 'set_typography', target: { sceneId: scene.id, layerId: layer.id }, value: { family } }));
    }
  },
  TEXT_TOO_SMALL: {
    policy: 'AUTO', op: 'set_typography', reason: 'Sub-18 px text is raised to the type-scale caption size, paired with a safe-area box enlargement when the raised size would overflow; if neither fits the defect escalates.',
    build(defect, { project }) {
      return layersInScope(defect, project, layer => layer.kind === 'text' && Number(layer.typography?.sizePx) < MIN_TYPOGRAPHY_SIZE_PX)
        .flatMap(({ scene, layer }) => textTooSmallOps(scene, layer, project));
    }
  },
  TEXT_SAFE_AREA_DISABLED: {
    policy: 'AUTO', op: 'set_typography', reason: 'Safe-area opt-out is reverted; safeArea may only be set to true, and boxes outside the safe area are clamped back inside it.',
    build(defect, { project }) {
      return [
        ...layersInScope(defect, project, layer => layer.kind === 'text' && layer.typography?.safeArea === false)
          .map(({ scene, layer }) => ({ type: 'set_typography', target: { sceneId: scene.id, layerId: layer.id }, value: { safeArea: true } })),
        ...clampTextLayerIntoSafeArea(defect, project)
      ];
    }
  },
  TEXT_TYPOGRAPHY_INCOMPLETE: {
    policy: 'COND', op: 'set_typography', reason: 'Incomplete text typography is filled from the brand font when one is declared.',
    build(defect, { project }) {
      const family = declaredFontFamily(project);
      if (!family) return [];
      const ops = [];
      for (const { scene, layer } of layersInScope(defect, project, layer => layer.kind === 'text')) {
        const value = {};
        if (!(layer.typography && typeof layer.typography.family === 'string' && layer.typography.family.trim())) value.family = family;
        if (!(Number(layer.typography?.sizePx) > 0)) value.sizePx = MIN_TYPOGRAPHY_SIZE_PX;
        if (Object.keys(value).length) ops.push({ type: 'set_typography', target: { sceneId: scene.id, layerId: layer.id }, value });
      }
      return ops;
    }
  },
  TEXT_OVERFLOW_ESTIMATED: {
    policy: 'COND', op: 'set_transform', reason: 'Estimated overflow first enlarges the text box within the safe area, then falls back to shrinking the font size (never below 18 px); text content is never patched.',
    build(defect, { project }) {
      return layersInScope(defect, project, layer => layer.kind === 'text')
        .flatMap(({ scene, layer }) => overflowRepairOps(scene, layer, project));
    }
  },
  TEXT_OUTSIDE_SAFE_AREA: {
    policy: 'COND', op: 'set_transform', reason: 'Text boxes are clamped back inside the configured safe area when they fit.',
    build: (defect, context) => clampTextLayerIntoSafeArea(defect, context.project)
  },
  OCR_TEXT_OUTSIDE_SAFE_AREA: {
    policy: 'COND', op: 'set_transform', reason: 'Recognized text outside the safe area is clamped back inside it only when exactly one text layer in the owning scene matches; ambiguous scenes are reported.',
    build(defect, context) {
      const candidates = textLayersOutsideSafeArea(defect, context.project);
      if (candidates.length !== 1) return [];
      const { scene, layer, box, bounds } = candidates[0];
      const maxX = bounds.width - bounds.marginX - box.width, maxY = bounds.height - bounds.marginY - box.height;
      if (maxX < bounds.marginX || maxY < bounds.marginY) return [];
      const clampedX = Math.min(Math.max(box.x, bounds.marginX), maxX);
      const clampedY = Math.min(Math.max(box.y, bounds.marginY), maxY);
      if (clampedX === box.x && clampedY === box.y) return [];
      return [{ type: 'set_transform', target: { sceneId: scene.id, layerId: layer.id }, value: { x: clampedX, y: clampedY } }];
    }
  },
  ASSET_REFERENCE_MISSING: {
    policy: 'COND', op: 'rebind_asset', reason: 'Missing asset references rebind to an existing same-kind asset when a verified candidate exists; missing media is never invented.',
    build(defect, context) {
      const assets = assetsById(context.project);
      const ops = [];
      for (const { scene, layer } of layersInScope(defect, context.project, layer => ASSET_KINDS.has(layer.kind) && typeof layer.assetId === 'string' && !assets.has(layer.assetId))) {
        const replacement = rebindCandidateFor(layer, context, layer.assetId);
        if (!replacement) continue;
        ops.push({ type: 'rebind_asset', target: { sceneId: scene.id, layerId: layer.id }, value: { assetId: replacement.id } });
      }
      return ops;
    }
  },
  ASSET_FILE_MISSING: {
    policy: 'COND', op: 'rebind_asset', reason: 'Layers pointing at an asset whose file is missing rebind to a verified same-kind candidate; missing media is never invented.',
    build(defect, context) {
      const missingAssetId = defect?.assetId;
      if (typeof missingAssetId !== 'string' || !missingAssetId) return [];
      const ops = [];
      for (const { scene, layer } of layersInScope(defect, context.project, layer => ASSET_KINDS.has(layer.kind) && layer.assetId === missingAssetId)) {
        const replacement = rebindCandidateFor(layer, context, missingAssetId);
        if (!replacement) continue;
        ops.push({ type: 'rebind_asset', target: { sceneId: scene.id, layerId: layer.id }, value: { assetId: replacement.id } });
      }
      return ops;
    }
  },
  ASSET_REFERENCE_UNRESOLVED: {
    policy: 'COND', op: 'rebind_asset', reason: 'Unresolved asset references rebind to an existing same-kind asset when a verified candidate exists.',
    build(defect, context) {
      return DEFECT_REPAIR_REGISTRY.ASSET_REFERENCE_MISSING.build(defect, context);
    }
  },
  LAYER_EXCEEDS_SCENE_DURATION: {
    policy: 'COND', op: 'set_timing', reason: 'Layer timings that overrun their scene are clamped to the scene duration.',
    build(defect, { project }) {
      const ops = [];
      for (const sceneId of scopeSceneIds(defect, project)) {
        const scene = (project.scenes || []).find(item => item?.id === sceneId);
        if (!scene || !positiveInteger(scene.durationFrames)) continue;
        for (const layer of Array.isArray(scene.layers) ? scene.layers : []) {
          if (!layer) continue;
          const start = Number.isInteger(layer.startFrame) ? layer.startFrame : 0;
          const duration = Number.isInteger(layer.durationFrames) ? layer.durationFrames : scene.durationFrames;
          if (start + duration <= scene.durationFrames) continue;
          if (scene.durationFrames - start < 1) continue;
          ops.push({ type: 'set_timing', target: { sceneId: scene.id, layerId: layer.id }, value: { durationFrames: scene.durationFrames - start } });
        }
      }
      return ops;
    }
  },
  INVALID_LAYER_START: {
    policy: 'COND', op: 'set_timing', reason: 'Negative or non-integer layer starts clamp to frame 0.',
    build(defect, { project }) {
      const ops = [];
      for (const sceneId of scopeSceneIds(defect, project)) {
        const scene = (project.scenes || []).find(item => item?.id === sceneId);
        for (const layer of Array.isArray(scene?.layers) ? scene.layers : []) {
          if (!layer || layer.startFrame === undefined || nonNegativeInteger(layer.startFrame)) continue;
          ops.push({ type: 'set_timing', target: { sceneId: scene.id, layerId: layer.id }, value: { startFrame: 0 } });
        }
      }
      return ops;
    }
  },
  INVALID_LAYER_DURATION: {
    policy: 'COND', op: 'set_timing', reason: 'Invalid layer durations clamp to the remaining scene duration.',
    build(defect, { project }) {
      const ops = [];
      for (const sceneId of scopeSceneIds(defect, project)) {
        const scene = (project.scenes || []).find(item => item?.id === sceneId);
        if (!scene || !positiveInteger(scene.durationFrames)) continue;
        for (const layer of Array.isArray(scene.layers) ? scene.layers : []) {
          if (!layer || layer.durationFrames === undefined || positiveInteger(layer.durationFrames)) continue;
          const start = Number.isInteger(layer.startFrame) ? layer.startFrame : 0;
          if (scene.durationFrames - start < 1) continue;
          ops.push({ type: 'set_timing', target: { sceneId: scene.id, layerId: layer.id }, value: { durationFrames: scene.durationFrames - start } });
        }
      }
      return ops;
    }
  },
  INVALID_AUDIO_OFFSET: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Negative or non-integer audio offsets clamp to frame 0.',
    build(defect, { project }) {
      return eachAudioCue(project).filter(({ cue }) => !nonNegativeInteger(cue.offsetFrames ?? cue.startFrame ?? 0))
        .map(({ target }) => ({ type: 'set_audio_cue', target, value: { offsetFrames: 0 } }));
    }
  },
  INVALID_AUDIO_DURATION: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Audio cue durations clamp to the remaining container timeline.',
    build(defect, { project }) {
      const ops = [];
      for (const { cue, target, containerEndFrame } of eachAudioCue(project)) {
        if (!positiveInteger(containerEndFrame)) continue;
        const start = nonNegativeInteger(cue.offsetFrames ?? 0) ? cue.offsetFrames : 0;
        const invalid = cue.durationFrames !== undefined && (!positiveInteger(cue.durationFrames) || start + cue.durationFrames > containerEndFrame);
        if (!invalid || containerEndFrame - start < 1) continue;
        ops.push({ type: 'set_audio_cue', target, value: { durationFrames: containerEndFrame - start } });
      }
      return ops;
    }
  },
  INVALID_AUDIO_VOLUME: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Out-of-range cue volumes clamp into the 0..4 supported band.',
    build(defect, { project }) {
      return eachAudioCue(project).filter(({ cue }) => cue.volume !== undefined && (!finiteNumber(cue.volume) || cue.volume < 0 || cue.volume > 4))
        .map(({ cue, target }) => ({ type: 'set_audio_cue', target, value: { volume: Math.max(0, Math.min(4, finiteNumber(cue.volume) ? cue.volume : 1)) } }));
    }
  },
  INVALID_AUDIO_FADE: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Invalid fade lengths clamp to the cue duration.',
    build(defect, { project }) {
      const ops = [];
      for (const { cue, target } of eachAudioCue(project)) {
        if (!positiveInteger(cue.durationFrames)) continue;
        const value = {};
        for (const field of ['fadeInFrames', 'fadeOutFrames']) {
          if (cue[field] === undefined) continue;
          if (nonNegativeInteger(cue[field]) && cue[field] <= cue.durationFrames) continue;
          value[field] = Math.max(0, Math.min(Math.floor(cue[field]), cue.durationFrames));
        }
        if (Object.keys(value).length) ops.push({ type: 'set_audio_cue', target, value });
      }
      return ops;
    }
  },
  AUDIO_FADES_OVERLAP: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Combined fades are scaled down proportionally to fit the cue duration.',
    build(defect, { project }) {
      const ops = [];
      for (const { cue, target } of eachAudioCue(project)) {
        if (!positiveInteger(cue.durationFrames)) continue;
        const fadeIn = Math.max(0, Number(cue.fadeInFrames ?? 0)), fadeOut = Math.max(0, Number(cue.fadeOutFrames ?? 0));
        if (fadeIn + fadeOut <= cue.durationFrames) continue;
        const scale = cue.durationFrames / (fadeIn + fadeOut);
        ops.push({ type: 'set_audio_cue', target, value: { fadeInFrames: Math.floor(fadeIn * scale), fadeOutFrames: Math.floor(fadeOut * scale) } });
      }
      return ops;
    }
  },
  BLACK_FRAME_SEGMENT: {
    policy: 'COND', op: 'set_timing',
    reason: 'Interior black frames are covered by extending or shifting the single layer adjacent to the coverage gap when layer timings explain the range; black frames at clip edges may be intentional fades and are reported.',
    build(defect, context) {
      return blackFrameCoverOps(defect, context.project);
    }
  },
  FROZEN_FRAME_SEGMENT: {
    policy: 'COND', op: 'set_motion',
    reason: 'Static holds gain a float motion preset on the owning static content layer when exactly one candidate exists; intentional design holds and ambiguous ownership are reported.',
    build(defect, context) {
      return frozenFrameMotionOps(defect, context.project);
    }
  },
  PERCEPTUAL_DUPLICATE_FRAMES: {
    policy: 'COND', op: 'set_motion',
    reason: 'Perceptually duplicated frames gain a float motion preset on the owning static content layer when the scene attribution identifies exactly one candidate.',
    build(defect, context) {
      return frozenFrameMotionOps(defect, context.project);
    }
  },
  AUDIO_SILENCE_SEGMENT: {
    policy: 'COND', op: 'set_audio_cue',
    reason: 'Silence attributable to cue placement is closed by extending or shifting the adjacent narration cue into the gap; intentional reviewed pauses are reported.',
    build(defect, context) {
      return audioGapClosureOps(defect, context.project);
    }
  },
  INVALID_AUDIO_DUCKING: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Non-boolean ducking flags reset to false.',
    build(defect, { project }) {
      return eachAudioCue(project).filter(({ cue }) => cue.duckAgainstNarration !== undefined && typeof cue.duckAgainstNarration !== 'boolean')
        .map(({ target }) => ({ type: 'set_audio_cue', target, value: { duckAgainstNarration: false } }));
    }
  },
  AUDIO_ASSET_REQUIRED: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Cues without an asset bind to the first declared audio asset when one exists.',
    build(defect, { project }) {
      const [assetId] = audioAssetIds(project);
      if (!assetId) return [];
      return eachAudioCue(project).filter(({ cue }) => typeof cue.assetId !== 'string' || !cue.assetId.trim())
        .map(({ target }) => ({ type: 'set_audio_cue', target, value: { assetId } }));
    }
  },
  AUDIO_ASSET_UNRESOLVED: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Cues pointing at non-audio assets rebind to the first declared audio asset when one exists.',
    build(defect, { project }) {
      const audioIds = new Set(audioAssetIds(project));
      const [assetId] = audioIds;
      if (!assetId) return [];
      return eachAudioCue(project).filter(({ cue }) => typeof cue.assetId !== 'string' || !audioIds.has(cue.assetId))
        .map(({ target }) => ({ type: 'set_audio_cue', target, value: { assetId } }));
    }
  },
  AUDIO_PROGRAM_TOO_QUIET: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Program loudness below the delivery range gains volume on overlapping cues within a cumulative ±6 dB budget per run, capped at 4.',
    build: audioGainOps
  },
  AUDIO_PROGRAM_TOO_LOUD: {
    policy: 'COND', op: 'set_audio_cue', reason: 'Program loudness above the delivery range reduces volume on overlapping cues within a cumulative ±6 dB budget per run, floored at 0.',
    build: audioGainOps
  },
  AUDIO_TRUE_PEAK_EXCEEDED: {
    policy: 'COND', op: 'set_audio_cue', reason: 'True-peak overshoot attenuates overlapping cues by the measured overshoot (reduction only) within the cumulative ±6 dB budget per run.',
    build: audioGainOps
  },

  CHECK_FAILED_IRSCENEDURATIONMATCHESPROJECT: {
    policy: 'AUTO', op: 'set_timing',
    reason: 'The project duration is canonicalized to the sum of scene durations, a projection that cannot change rendered output.',
    build(defect, { project }) {
      const total = (Array.isArray(project?.scenes) ? project.scenes : []).reduce((sum, scene) => sum + (Number.isInteger(scene?.durationFrames) ? scene.durationFrames : 0), 0);
      if (!total || total === Number(project?.project?.totalDurationFrames)) return [];
      return [{ type: 'set_timing', target: { scope: 'project' }, value: { totalDurationFrames: total } }];
    }
  },
  REPORT: { policy: 'REPORT', op: null, reason: 'No deterministic patch exists for this defect; escalate to the owning repairer.' },
  PROJECT_MISSING: { policy: 'REPORT', op: null, reason: 'A missing project cannot be patched; rebuild the IR.' },
  PROJECT_NOT_OBJECT: { policy: 'REPORT', op: null, reason: 'A non-object IR cannot be patched; rebuild the IR.' },
  UNSUPPORTED_SCHEMA_VERSION: { policy: 'REPORT', op: null, reason: 'Schema migrations are out of scope for patches.' },
  PROJECT_METADATA_MISSING: { policy: 'REPORT', op: null, reason: 'Missing project metadata requires creative input.' },
  REQUIRED_FIELD: { policy: 'REPORT', op: null, reason: 'Missing required copy/identity fields need creative decisions.' },
  INVALID_FRAME_RATE: { policy: 'REPORT', op: null, reason: 'Frame rate is an output-contract decision, not a safe patch.' },
  INVALID_CANVAS: { policy: 'REPORT', op: null, reason: 'Canvas dimensions are an output-contract decision.' },
  INVALID_TOTAL_DURATION: { policy: 'REPORT', op: null, reason: 'Total duration is an output-contract decision.' },
  CREATIVE_BRIEF_MISSING: { policy: 'REPORT', op: null, reason: 'The creative brief must be authored, not patched.' },
  SCENES_REQUIRED: { policy: 'REPORT', op: null, reason: 'Authoring at least one scene is a creative decision.' },
  INVALID_SCENE: { policy: 'REPORT', op: null, reason: 'Structural scene corruption requires re-authoring.' },
  DUPLICATE_SCENE_ID: { policy: 'REPORT', op: null, reason: 'Identity conflicts require re-authoring.' },
  INVALID_SCENE_DURATION: { policy: 'REPORT', op: null, reason: 'Scene durations drive the timeline contract; repair by re-authoring.' },
  INVALID_SCENE_START: { policy: 'REPORT', op: null, reason: 'Scene starts drive the timeline contract; repair by re-authoring.' },
  SCENE_EXCEEDS_PROJECT_DURATION: { policy: 'REPORT', op: null, reason: 'Timeline overruns need a duration decision from the producer.' },
  SCENES_EXCEED_PROJECT_DURATION: { policy: 'REPORT', op: null, reason: 'Timeline overruns need a duration decision from the producer.' },
  LAYERS_REQUIRED: { policy: 'REPORT', op: null, reason: 'Empty scenes need re-authoring.' },
  INVALID_LAYER: { policy: 'REPORT', op: null, reason: 'Structural layer corruption requires re-authoring.' },
  DUPLICATE_LAYER_ID: { policy: 'REPORT', op: null, reason: 'Identity conflicts require re-authoring.' },
  UNKNOWN_LAYER_KIND: { policy: 'REPORT', op: null, reason: 'Layer kinds are fixed by the IR schema, not patchable.' },
  UNKNOWN_ENGINE_HINT: { policy: 'REPORT', op: null, reason: 'Engine hints are routing decisions.' },
  ASSETS_NOT_ARRAY: { policy: 'REPORT', op: null, reason: 'Structural asset corruption requires re-authoring.' },
  ASSET_ID_REQUIRED: { policy: 'REPORT', op: null, reason: 'Asset identity must be re-authored.' },
  DUPLICATE_ASSET_ID: { policy: 'REPORT', op: null, reason: 'Identity conflicts require re-authoring.' },
  INVALID_ASSET_CHECKSUM: { policy: 'REPORT', op: null, reason: 'Checksums come from the asset registry, not from patches.' },
  INVALID_AUDIO_CUES: { policy: 'REPORT', op: null, reason: 'Structural cue corruption requires re-authoring.' },
  INVALID_AUDIO_TRACKS: { policy: 'REPORT', op: null, reason: 'Structural track corruption requires re-authoring.' },
  DELIVERY_TARGET_REQUIRED: { policy: 'REPORT', op: null, reason: 'Delivery targets are output contracts.' },
  INVALID_DELIVERY_DIMENSIONS: { policy: 'REPORT', op: null, reason: 'Delivery targets are output contracts.' },
  INVALID_DELIVERY_FRAME_RATE: { policy: 'REPORT', op: null, reason: 'Delivery targets are output contracts.' },
  EXTERNAL_ASSET: { policy: 'REPORT', op: null, reason: 'Offline reproducibility requires a human to attach a local asset.' },
  NON_HYPERFRAMES_LAYER: { policy: 'REPORT', op: null, reason: 'Cross-engine routing is decided by the router, not the patcher.' },
  UNSUPPORTED_LAYER_KIND: { policy: 'REPORT', op: null, reason: 'Adapter support gaps are engineering work, not patches.' },
  ENGINE_UNAVAILABLE: { policy: 'REPORT', op: null, reason: 'Engine availability is a host/runtime condition.' },
  CAPABILITY_UNMAPPED: { policy: 'REPORT', op: null, reason: 'Capability maps are engineering data.' },
  RENDER_MANIFEST_MISSING: { policy: 'REPORT', op: null, reason: 'Render evidence must be regenerated by rendering.' },
  RENDER_NOT_VERIFIED: { policy: 'REPORT', op: null, reason: 'Verification failures require a rerender, not an IR patch.' },
  OUTPUT_PATH_MISSING: { policy: 'REPORT', op: null, reason: 'Render artifacts must be regenerated by rendering.' },
  OUTPUT_EMPTY: { policy: 'REPORT', op: null, reason: 'Render artifacts must be regenerated by rendering.' },
  OUTPUT_CHECKS_MISSING: { policy: 'REPORT', op: null, reason: 'Render evidence must be regenerated by rendering.' },
  FRAME_EVIDENCE_MISSING: { policy: 'REPORT', op: null, reason: 'Render evidence must be regenerated by rendering.' },
  AUDIO_STREAM_MISSING: { policy: 'REPORT', op: null, reason: 'A missing audio stream requires attaching narration, not patching volumes.' },
  OCR_FRAME_FAILED: { policy: 'REPORT', op: null, reason: 'OCR failures are evidence-collection problems.' },
  OCR_BOTTOM_TEXT_REVIEW: { policy: 'REPORT', op: null, reason: 'Advisory lower-third review needs human judgment.' },
  OCR_REQUIRED_UNAVAILABLE: { policy: 'REPORT', op: null, reason: 'Tooling availability is a host condition.' },
  MEDIA_FINDING: { policy: 'REPORT', op: null, reason: 'Unstructured media findings need human triage.' }
};

const REPORT_PREFIXES = [
  { prefix: 'CHECK_FAILED_', reason: 'Failed output-contract checks require a rerender with corrected evidence.' }
];

// FRAME_DECODE_FAILED_n: no IR patch exists; the repair executor allows exactly
// one transient re-render retry for the affected frame and escalates when the
// same frame fails again (design §3.3).
const FRAME_DECODE_RETRY_ENTRY = {
  policy: 'COND', op: null, retry: 'rerender-once',
  reason: 'No IR patch exists for undecodable frame samples; allow exactly one transient re-render retry, escalating when the same frame fails again.',
  build: () => []
};

export function registryEntryFor(code) {
  const key = String(code || '');
  if (DEFECT_REPAIR_REGISTRY[key]) return DEFECT_REPAIR_REGISTRY[key];
  if (key.startsWith('BLOCKING_') && DEFECT_REPAIR_REGISTRY[key.slice('BLOCKING_'.length)]) {
    const entry = DEFECT_REPAIR_REGISTRY[key.slice('BLOCKING_'.length)];
    return { ...entry, reason: 'Blocking compiler warning (' + key + '): ' + entry.reason };
  }
  if (key.startsWith('FRAME_DECODE_FAILED_')) return FRAME_DECODE_RETRY_ENTRY;
  const prefix = REPORT_PREFIXES.find(item => key.startsWith(item.prefix));
  if (prefix) return { policy: 'REPORT', op: null, reason: prefix.reason };
  return DEFECT_REPAIR_REGISTRY.REPORT;
}

export function classifyDefects(defects, { project, routePlan, runId, verifiedAssetIds } = {}) {
  const context = { project, routePlan, verifiedAssetIds };
  // One shared gain budget per classification: gain builders spend against it
  // as ops are emitted, so N defects cannot overspend the ±6 dB run budget the
  // way independent snapshots of the same total could.
  context.gainBudget = { limitDb: GAIN_BUDGET_DB, usedDb: 0, cueGains: new Map() };
  if (runId !== undefined) {
    context.gainBudget.runId = runId;
    context.gainBudget.usedDb = computeRunGainBudgetUsed(project, runId);
  }
  const items = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    if (!defect || typeof defect !== 'object' || !defect.code) continue;
    const entry = registryEntryFor(defect.code);
    const built = entry.build ? entry.build(defect, context) : [];
    const ops = Array.isArray(built) ? built.filter(Boolean) : [];
    items.push({
      defectId: defect.defectId || null,
      code: defect.code,
      severity: defect.severity || 'medium',
      sceneId: defect.sceneId || null,
      policy: entry.policy,
      op: entry.op,
      ops: entry.policy === 'REPORT' ? [] : ops,
      reason: entry.policy !== 'REPORT' && !ops.length
        ? (entry.retry ? entry.reason : 'Condition not met: ' + entry.reason)
        : entry.reason
    });
  }
  const counts = {
    total: items.length,
    AUTO: items.filter(item => item.policy === 'AUTO').length,
    COND: items.filter(item => item.policy === 'COND').length,
    REPORT: items.filter(item => item.policy === 'REPORT').length,
    repairable: items.filter(item => item.ops.length > 0).length
  };
  return { counts, items };
}

export function createPatchFromDefects(project, classification, { attempt = 0, maxCycles = 2, runId } = {}) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new PatchError('A Canonical Video IR project object is required.', { code: 'PATCH_PROJECT_REQUIRED' });
  if (!classification || !Array.isArray(classification.items)) throw new PatchError('classifyDefects() output with an items array is required.', { code: 'PATCH_CLASSIFICATION_REQUIRED' });
  if (typeof runId !== 'string' || !runId.trim()) throw new PatchError('A non-empty runId is required to build a repair patch.', { code: 'PATCH_RUN_ID_REQUIRED' });
  if (!Number.isInteger(attempt) || attempt < 0) throw new PatchError('attempt must be a non-negative integer.', { code: 'PATCH_ATTEMPT_INVALID' });
  if (!Number.isInteger(maxCycles) || maxCycles < 0 || maxCycles > MAX_REPAIR_CYCLES) throw new PatchError('maxCycles must be an integer between 0 and ' + MAX_REPAIR_CYCLES + '.', { code: 'PATCH_MAX_CYCLES_INVALID' });
  const ops = [];
  const seenOps = new Set();
  for (const item of classification.items) {
    for (const op of item.ops) {
      // Auto-repair can emit the same deterministic op from two defect codes
      // (e.g. safe-area disable and outside-safe-area); identical ops are
      // idempotent, so collapse exact duplicates instead of applying twice.
      const identity = JSON.stringify([op.type, op.target, op.value]);
      if (seenOps.has(identity)) continue;
      seenOps.add(identity);
      ops.push({ ...op, reason: { defectId: item.defectId, code: item.code, policy: item.policy } });
    }
  }
  if (!ops.length) return null;
  return {
    runId, attempt, maxCycles,
    basedOnIrSha256: projectIrSha256(project),
    ops,
    skipped: classification.items.filter(item => !item.ops.length).map(item => ({ defectId: item.defectId, code: item.code, policy: item.policy, reason: item.reason })),
    createdAt: new Date().toISOString()
  };
}

function validateOpValues(op, opPath, project, issues) {
  const value = op.value;
  const at = opPath + '.value';
  const reject = (field, message) => issues.push(issue('PATCH_VALUE_INVALID', at + '.' + field, message));
  const whitelist = VALUE_FIELDS[op.type];
  for (const field of Object.keys(value)) {
    if (!whitelist.has(field)) issues.push(issue('PATCH_FIELD_NOT_PERMITTED', at + '.' + field, 'Field is not permitted for ' + op.type + ' operations: ' + field + '.'));
  }
  if (op.type === 'set_typography') {
    if (value.family !== undefined) {
      if (typeof value.family !== 'string' || !value.family.trim()) reject('family', 'family must be a non-empty string.');
      else {
        const fonts = brandFonts(project);
        if (!fonts || !Object.values(fonts).includes(value.family)) reject('family', 'family must be declared in project.brand.fonts: ' + value.family + '.');
      }
    }
    if (value.sizePx !== undefined && (!Number.isInteger(value.sizePx) || value.sizePx < MIN_TYPOGRAPHY_SIZE_PX)) reject('sizePx', 'sizePx must be an integer of at least ' + MIN_TYPOGRAPHY_SIZE_PX + ' px.');
    if (value.weight !== undefined && (!finiteNumber(value.weight) || value.weight <= 0)) reject('weight', 'weight must be a positive finite number.');
    if (value.lineHeight !== undefined && (!finiteNumber(value.lineHeight) || value.lineHeight <= 0 || value.lineHeight > 4)) reject('lineHeight', 'lineHeight must be a finite number above 0 and at most 4.');
    if (value.tracking !== undefined && (!finiteNumber(value.tracking) || value.tracking < 0)) reject('tracking', 'tracking must be a non-negative finite number.');
    if (value.alignment !== undefined && !TEXT_ALIGNMENTS.has(value.alignment)) reject('alignment', 'alignment must be one of: ' + [...TEXT_ALIGNMENTS].join(', ') + '.');
    if (value.maxLines !== undefined && (!Number.isInteger(value.maxLines) || value.maxLines < 1)) reject('maxLines', 'maxLines must be a positive integer.');
    if (value.safeArea !== undefined && value.safeArea !== true) reject('safeArea', 'safeArea may only be set to true.');
  } else if (op.type === 'set_transform') {
    for (const field of ['x', 'y', 'rotation']) if (value[field] !== undefined && !finiteNumber(value[field])) reject(field, field + ' must be a finite number.');
    for (const field of ['width', 'height', 'scale']) if (value[field] !== undefined && (!finiteNumber(value[field]) || value[field] <= 0)) reject(field, field + ' must be a positive finite number.');
  } else if (op.type === 'set_motion') {
    if (value.preset !== undefined && (typeof value.preset !== 'string' || !MOTION_PRESETS.has(value.preset))) reject('preset', 'preset must be one the adapter implements: ' + [...MOTION_PRESETS].join(', ') + '.');
    if (value.easing !== undefined && (typeof value.easing !== 'string' || !MOTION_EASINGS.has(value.easing))) reject('easing', 'easing must be one the adapter implements: ' + [...MOTION_EASINGS].join(', ') + '.');
    for (const field of ['durationFrames', 'delayFrames']) if (value[field] !== undefined && !nonNegativeInteger(value[field])) reject(field, field + ' must be a non-negative integer.');
  } else if (op.type === 'set_timing') {
    if (value.startFrame !== undefined && !nonNegativeInteger(value.startFrame)) reject('startFrame', 'startFrame must be a non-negative integer.');
    if (value.durationFrames !== undefined && !positiveInteger(value.durationFrames)) reject('durationFrames', 'durationFrames must be a positive integer.');
    if (value.totalDurationFrames !== undefined) {
      const sceneTotal = (Array.isArray(project?.scenes) ? project.scenes : []).reduce((sum, scene) => sum + (Number.isInteger(scene?.durationFrames) ? scene.durationFrames : 0), 0);
      if (!positiveInteger(value.totalDurationFrames)) reject('totalDurationFrames', 'totalDurationFrames must be a positive integer.');
      else if (value.totalDurationFrames !== sceneTotal) reject('totalDurationFrames', 'totalDurationFrames must equal the sum of scene durations (' + sceneTotal + ').');
    }
  } else if (op.type === 'rebind_asset') {
    const asset = typeof value.assetId === 'string' ? assetsById(project).get(value.assetId) : undefined;
    if (!asset) reject('assetId', 'assetId must reference an asset declared in project.assets.');
  } else if (op.type === 'set_audio_cue') {
    if (value.assetId !== undefined) {
      const asset = typeof value.assetId === 'string' ? assetsById(project).get(value.assetId) : undefined;
      if (!asset || asset.kind !== 'audio') reject('assetId', 'assetId must reference an audio asset declared in project.assets.');
    }
    if (value.offsetFrames !== undefined && !nonNegativeInteger(value.offsetFrames)) reject('offsetFrames', 'offsetFrames must be a non-negative integer.');
    if (value.durationFrames !== undefined && !positiveInteger(value.durationFrames)) reject('durationFrames', 'durationFrames must be a positive integer.');
    if (value.volume !== undefined && (!finiteNumber(value.volume) || value.volume < 0 || value.volume > 4)) reject('volume', 'volume must be a finite number between 0 and 4.');
    for (const field of ['fadeInFrames', 'fadeOutFrames']) if (value[field] !== undefined && !nonNegativeInteger(value[field])) reject(field, field + ' must be a non-negative integer.');
    if (value.duckAgainstNarration !== undefined && typeof value.duckAgainstNarration !== 'boolean') reject('duckAgainstNarration', 'duckAgainstNarration must be a boolean.');
  }
}

function resolveTarget(project, target, opPath, issues) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    issues.push(issue('PATCH_TARGET_INVALID', opPath + '.target', 'Target must be an object with sceneId/layerId/index selectors.'));
    return null;
  }
  const at = opPath + '.target';
  for (const key of Object.keys(target)) {
    if (!['sceneId', 'layerId', 'index', 'scope'].includes(key)) issues.push(issue('PATCH_TARGET_FIELD_NOT_PERMITTED', at + '.' + key, 'Target selector is not permitted: ' + key + '.'));
  }
  if (target.scope !== undefined) {
    if (target.scope !== 'project') {
      issues.push(issue('PATCH_TARGET_INVALID', at + '.scope', 'scope must be "project" when provided.'));
      return null;
    }
    if (target.sceneId !== undefined || target.layerId !== undefined || target.index !== undefined) {
      issues.push(issue('PATCH_TARGET_INVALID', at, 'A project-scope target cannot be combined with sceneId, layerId or index.'));
      return null;
    }
    return { scope: 'project' };
  }
  const sceneId = target.sceneId;
  if (sceneId !== undefined && (typeof sceneId !== 'string' || !sceneId.trim())) {
    issues.push(issue('PATCH_TARGET_INVALID', at + '.sceneId', 'sceneId must be a non-empty string when provided.'));
    return null;
  }
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const scene = sceneId === undefined ? null : scenes.find(item => item?.id === sceneId);
  if (sceneId !== undefined && !scene) {
    issues.push(issue('PATCH_TARGET_UNRESOLVED', at + '.sceneId', 'No scene with id ' + sceneId + ' exists in this project.'));
    return null;
  }
  if (target.layerId !== undefined) {
    if (typeof target.layerId !== 'string' || !target.layerId.trim()) {
      issues.push(issue('PATCH_TARGET_INVALID', at + '.layerId', 'layerId must be a non-empty string when provided.'));
      return null;
    }
    const layer = (Array.isArray(scene?.layers) ? scene.layers : []).find(item => item?.id === target.layerId);
    if (!layer) {
      issues.push(issue('PATCH_TARGET_UNRESOLVED', at + '.layerId', 'No layer with id ' + target.layerId + ' exists in scene ' + sceneId + '.'));
      return null;
    }
    return { scene, layer };
  }
  if (target.index !== undefined) {
    const container = sceneId !== undefined ? (Array.isArray(scene?.audioCues) ? scene.audioCues : null) : (Array.isArray(project?.audio?.tracks) ? project.audio.tracks : null);
    if (!container || !Number.isInteger(target.index) || target.index < 0 || target.index >= container.length) {
      issues.push(issue('PATCH_TARGET_UNRESOLVED', at + '.index', 'No audio cue exists at the requested index' + (sceneId !== undefined ? ' in scene ' + sceneId : ' in project.audio.tracks') + '.'));
      return null;
    }
    return { scene, cue: container[target.index] };
  }
  if (sceneId !== undefined) return { scene };
  issues.push(issue('PATCH_TARGET_INVALID', at, 'Target must include layerId or index; scene-level targets are only valid for set_timing.'));
  return null;
}

export function validateRepairPatch(patch, project) {
  const issues = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, issues: [issue('PATCH_NOT_OBJECT', '$', 'Repair patch must be a JSON object.')], summary: { errors: 1, warnings: 0 } };
  }
  if (!isHex64(patch.basedOnIrSha256)) issues.push(issue('PATCH_BASE_INVALID', '$.basedOnIrSha256', 'basedOnIrSha256 must contain 64 hexadecimal characters.'));
  if (!Array.isArray(patch.ops) || patch.ops.length === 0) issues.push(issue('PATCH_OPS_REQUIRED', '$.ops', 'Repair patch must carry a non-empty ops array.'));
  else patch.ops.forEach((op, index) => {
    const opPath = '$.ops[' + index + ']';
    if (!op || typeof op !== 'object' || Array.isArray(op)) { issues.push(issue('PATCH_OP_INVALID', opPath, 'Each operation must be an object.')); return; }
    if (!OP_TYPES.has(op.type)) {
      issues.push(issue('PATCH_OP_TYPE_UNKNOWN', opPath + '.type', 'Unsupported operation type: ' + String(op.type) + '. Supported: ' + [...OP_TYPES].join(', ') + '.'));
      return;
    }
    if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value) || Object.keys(op.value).length === 0) {
      issues.push(issue('PATCH_VALUE_REQUIRED', opPath + '.value', 'Operation value must be a non-empty object.'));
      return;
    }
    const resolved = resolveTarget(project, op.target, opPath, issues);
    if (resolved && LAYER_OP_TYPES.has(op.type) && !resolved.layer) {
      issues.push(issue('PATCH_TARGET_INVALID', opPath + '.target', op.type + ' targets a layer; provide sceneId and layerId.'));
    }
    if (op.type === 'set_audio_cue' && resolved && !resolved.cue) {
      issues.push(issue('PATCH_TARGET_INVALID', opPath + '.target', 'set_audio_cue targets an audio cue; provide a sceneId or track scope plus index.'));
    }
    if (op.type === 'set_typography' && resolved?.layer && resolved.layer.kind !== 'text') {
      issues.push(issue('PATCH_TARGET_INVALID', opPath + '.target.layerId', 'set_typography targets text layers only; layer ' + resolved.layer.id + ' has kind ' + resolved.layer.kind + '.'));
    }
    if (op.type === 'rebind_asset' && resolved?.layer) {
      if (!ASSET_KINDS.has(resolved.layer.kind)) issues.push(issue('PATCH_TARGET_INVALID', opPath + '.target.layerId', 'rebind_asset targets image, video or audio layers; layer ' + resolved.layer.id + ' has kind ' + resolved.layer.kind + '.'));
      else if (typeof op.value.assetId === 'string') {
        const asset = assetsById(project).get(op.value.assetId);
        if (asset && asset.kind !== resolved.layer.kind) issues.push(issue('PATCH_ASSET_KIND_MISMATCH', opPath + '.value.assetId', 'Asset kind ' + asset.kind + ' does not match layer kind ' + resolved.layer.kind + '.'));
      }
    }
    validateOpValues(op, opPath, project, issues);
  });
  if (isHex64(patch.basedOnIrSha256) && project && typeof project === 'object' && patch.basedOnIrSha256 !== projectIrSha256(project)) {
    issues.push(issue('PATCH_BASE_MISMATCH', '$.basedOnIrSha256', 'basedOnIrSha256 does not match the current project IR hash.'));
  }
  const errors = issues.filter(item => item.severity === 'error');
  return { valid: errors.length === 0, issues, summary: { errors: errors.length, warnings: issues.length - errors.length } };
}

function applyOp(patched, op, index) {
  const at = 'ops[' + index + ']';
  const fail = (message, code = 'PATCH_TARGET_UNRESOLVED') => {
    throw new PatchError('Operation ' + at + ' failed: ' + message, { code, details: { index, type: op.type, target: structuredClone(op.target) } });
  };
  const scene = op.target?.sceneId !== undefined ? (patched.scenes || []).find(item => item?.id === op.target.sceneId) : null;
  if (op.target?.sceneId !== undefined && !scene) fail('scene ' + op.target.sceneId + ' no longer resolves against the patched IR.');
  const layer = op.target?.layerId !== undefined ? (Array.isArray(scene?.layers) ? scene.layers : []).find(item => item?.id === op.target.layerId) : null;
  if (op.target?.layerId !== undefined && !layer) fail('layer ' + op.target.layerId + ' no longer resolves against the patched IR.');
  const mergeInto = (holder, field) => {
    const current = holder[field] && typeof holder[field] === 'object' && !Array.isArray(holder[field]) ? holder[field] : {};
    holder[field] = { ...current, ...structuredClone(op.value) };
  };
  switch (op.type) {
    case 'set_typography':
    case 'set_transform':
    case 'set_motion':
    case 'rebind_asset':
      if (!layer) fail(op.type + ' targets a layer; provide sceneId and layerId.', 'PATCH_TARGET_INVALID');
      break;
    default:
      break;
  }
  switch (op.type) {
    case 'set_typography':
      if (layer.kind !== 'text') fail('set_typography targets text layers only.', 'PATCH_TARGET_INVALID');
      mergeInto(layer, 'typography');
      break;
    case 'set_transform':
      mergeInto(layer, 'transform');
      break;
    case 'set_motion':
      mergeInto(layer, 'motion');
      break;
    case 'set_timing':
      if (op.target?.scope === 'project') {
        if (op.target.sceneId !== undefined || op.target.layerId !== undefined || op.target.index !== undefined) fail('project-scope set_timing cannot carry scene, layer or cue selectors.', 'PATCH_TARGET_INVALID');
        if (op.value.totalDurationFrames === undefined) fail('project-scope set_timing requires totalDurationFrames.', 'PATCH_VALUE_INVALID');
        patched.project = { ...(patched.project || {}), totalDurationFrames: op.value.totalDurationFrames };
      } else if (layer) Object.assign(layer, structuredClone(op.value));
      else if (scene) Object.assign(scene, structuredClone(op.value));
      else fail('set_timing needs a project scope, scene or layer target.', 'PATCH_TARGET_INVALID');
      break;
    case 'rebind_asset':
      if (!ASSET_KINDS.has(layer.kind)) fail('rebind_asset targets image, video or audio layers only.', 'PATCH_TARGET_INVALID');
      layer.assetId = op.value.assetId;
      break;
    case 'set_audio_cue': {
      const container = op.target?.sceneId !== undefined
        ? (Array.isArray(scene.audioCues) ? scene.audioCues : null)
        : (Array.isArray(patched.audio?.tracks) ? patched.audio.tracks : null);
      if (!container || !container[op.target.index]) fail('the targeted audio cue no longer resolves against the patched IR.');
      Object.assign(container[op.target.index], structuredClone(op.value));
      break;
    }
    default:
      fail('unsupported operation type: ' + op.type, 'PATCH_OP_TYPE_UNKNOWN');
  }
}

export function applyRepairPatch(project, patch) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new PatchError('A Canonical Video IR project object is required.', { code: 'PATCH_PROJECT_REQUIRED' });
  const currentHash = projectIrSha256(project);
  if (patch?.basedOnIrSha256 !== currentHash) {
    throw new PatchError('Repair patch is based on a different IR revision (compare-and-swap failed).', {
      code: 'PATCH_BASE_MISMATCH',
      details: { basedOnIrSha256: patch?.basedOnIrSha256 ?? null, currentIrSha256: currentHash }
    });
  }
  const validation = validateRepairPatch(patch, project);
  if (!validation.valid) throw new PatchError('Repair patch was rejected by validation.', { code: 'PATCH_INVALID', details: validation });
  const baseline = new Set(validateProject(project).issues.map(item => item.code));
  const patched = structuredClone(project);
  const appliedOps = [];
  // Operations apply sequentially; every target re-resolves against the patched clone.
  for (const [index, op] of patch.ops.entries()) {
    applyOp(patched, op, index);
    appliedOps.push({ type: op.type, target: structuredClone(op.target), value: structuredClone(op.value) });
  }
  const result = validateProject(patched);
  const newCodes = [...new Set(result.issues.filter(item => !baseline.has(item.code)).map(item => item.code))];
  if (!result.valid || newCodes.length > 0) {
    throw new PatchError('Patched IR failed Canonical Video IR validation.', {
      code: 'PATCH_VALIDATION_FAILED',
      details: { valid: result.valid, newCodes, issues: result.issues }
    });
  }
  return { project: patched, patchedIrSha256: projectIrSha256(patched), appliedOps };
}

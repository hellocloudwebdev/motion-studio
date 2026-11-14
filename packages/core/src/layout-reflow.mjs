import { estimateTextFit } from './typography.mjs';

// True per-target layout reflow (roadmap P3.3). A delivery target with a
// different aspect ratio than the render canvas gets a DERIVED Canonical Video
// IR whose layout is recomputed for the target canvas — typography rescaled,
// boxes re-clamped into the target safe area, full-canvas backgrounds refilled
// — instead of scaling the master with pad bars. The transform is a pure,
// deterministic function of the IR: the same project and target always produce
// the same reflowed layout and the same change record.

// Same floor as patch.mjs's MIN_TYPOGRAPHY_SIZE_PX: reflow never produces
// sub-18 px text, so the reflowed IR passes TEXT_TOO_SMALL cleanly.
const MIN_TYPOGRAPHY_SIZE_PX = 18;

const POSITIVE_INT = value => Number.isInteger(value) && value > 0;

function safeAreaBounds(width, height, safeAreaPercent) {
  const percent = Number.isFinite(Number(safeAreaPercent)) && Number(safeAreaPercent) >= 0 ? Number(safeAreaPercent) : 5;
  return { marginX: width * percent / 100, marginY: height * percent / 100 };
}

function reflowLayer(layer, { oldCanvas, newCanvas, ratios, bounds, changes, sceneId }) {
  const { widthRatio, heightRatio, uniformScale } = ratios;
  const layerWidth = Number(layer?.transform?.width), layerHeight = Number(layer?.transform?.height);
  const layerX = Number(layer?.transform?.x), layerY = Number(layer?.transform?.y);
  if (![layerWidth, layerHeight].every(POSITIVE_INT) || ![layerX, layerY].every(Number.isFinite)) return layer;

  // Full-canvas backgrounds refill the target exactly; every other layer maps
  // its relative anchor and rescales without distortion.
  const fillsCanvas = layerX === 0 && layerY === 0 && layerWidth === oldCanvas.width && layerHeight === oldCanvas.height;
  const next = { x: layerX, y: layerY, width: layerWidth, height: layerHeight };
  if (fillsCanvas) {
    next.x = 0;
    next.y = 0;
    next.width = newCanvas.width;
    next.height = newCanvas.height;
  } else {
    next.x = Math.round(layerX / oldCanvas.width * newCanvas.width);
    next.y = Math.round(layerY / oldCanvas.height * newCanvas.height);
    // Text boxes take the horizontal space offered by the target (copy must
    // use the real width, e.g. the taller column of a 9:16 profile); every
    // other layer scales uniformly so media is never distorted.
    if (layer.kind === 'text') {
      next.width = Math.min(Math.max(1, Math.round(layerWidth * widthRatio)), Math.max(1, newCanvas.width - 2 * bounds.marginX));
      next.height = Math.max(1, Math.round(layerHeight * uniformScale));
    } else {
      next.width = Math.max(1, Math.round(layerWidth * uniformScale));
      next.height = Math.max(1, Math.round(layerHeight * uniformScale));
    }
  }

  // Clamp the reflowed box into the target safe area — same clamp policy as
  // the repair registry (patch.mjs): shift, never resize below the reflowed
  // size; when the box cannot fit, pin it to the margin origin.
  if (!fillsCanvas) {
    const maxX = newCanvas.width - bounds.marginX - next.width;
    const maxY = newCanvas.height - bounds.marginY - next.height;
    next.x = maxX < bounds.marginX ? bounds.marginX : Math.min(Math.max(next.x, bounds.marginX), Math.round(maxX));
    next.y = maxY < bounds.marginY ? bounds.marginY : Math.min(Math.max(next.y, bounds.marginY), Math.round(maxY));
  }

  const typography = layer.kind === 'text' && layer.typography && Number(layer.typography.sizePx) > 0
    ? { ...layer.typography, sizePx: Math.max(MIN_TYPOGRAPHY_SIZE_PX, Math.round(layer.typography.sizePx * uniformScale)) }
    : layer.typography;

  const moved = next.x !== layerX || next.y !== layerY || next.width !== layerWidth || next.height !== layerHeight;
  const sizeChanged = typography && typography.sizePx !== layer.typography?.sizePx;
  if (!moved && !sizeChanged) return layer;
  changes.push({
    sceneId,
    layerId: layer.id,
    from: { x: layerX, y: layerY, width: layerWidth, height: layerHeight, ...(layer.typography?.sizePx ? { sizePx: layer.typography.sizePx } : {}) },
    to: { x: next.x, y: next.y, width: next.width, height: next.height, ...(typography && typography.sizePx !== layer.typography?.sizePx ? { sizePx: typography.sizePx } : {}) }
  });
  return { ...layer, transform: { ...layer.transform, ...next }, ...(typography && typography !== layer.typography ? { typography } : {}) };
}

export function reflowProjectForTarget(project, { width, height } = {}) {
  const canvas = project?.project?.canvas;
  if (!POSITIVE_INT(width) || !POSITIVE_INT(height)) throw new Error('Reflow requires positive integer target dimensions.');
  if (!canvas || !POSITIVE_INT(Number(canvas.width)) || !POSITIVE_INT(Number(canvas.height))) throw new Error('Reflow requires a project canvas with positive integer dimensions.');
  const oldCanvas = { width: Number(canvas.width), height: Number(canvas.height) };
  const newCanvas = { width, height, pixelAspectRatio: 1, safeAreaPercent: canvas.safeAreaPercent ?? 5 };
  const changes = [];
  if (oldCanvas.width === width && oldCanvas.height === height) {
    // Same aspect: the master layout already fits the target canvas.
    return { project: structuredClone(project), changes, reflowed: false };
  }
  const ratios = {
    widthRatio: width / oldCanvas.width,
    heightRatio: height / oldCanvas.height,
    uniformScale: Math.min(width / oldCanvas.width, height / oldCanvas.height)
  };
  const bounds = safeAreaBounds(width, height, newCanvas.safeAreaPercent);
  const reflowed = structuredClone(project);
  reflowed.project.canvas = newCanvas;
  for (const scene of Array.isArray(reflowed.scenes) ? reflowed.scenes : []) {
    if (!scene || !Array.isArray(scene.layers)) continue;
    scene.layers = scene.layers.map(layer => reflowLayer(layer, { oldCanvas, newCanvas, ratios, bounds, changes, sceneId: scene.id }));
  }
  return { project: reflowed, changes, reflowed: true };
}

// Readability audit for a reflowed layout: every text layer must still fit its
// reflowed box at the reflowed size (or the box grows, or the finding reports
// the overflow for review). Pure function, used by the variant render path to
// fail loudly instead of delivering an overflowing variant.
export function auditReflowedLayout(project) {
  const canvas = project?.project?.canvas;
  const findings = [];
  if (!canvas || !POSITIVE_INT(Number(canvas.width)) || !POSITIVE_INT(Number(canvas.height))) throw new Error('Audit requires a project canvas with positive integer dimensions.');
  const bounds = safeAreaBounds(Number(canvas.width), Number(canvas.height), canvas.safeAreaPercent);
  for (const scene of Array.isArray(project.scenes) ? project.scenes : []) {
    for (const layer of Array.isArray(scene?.layers) ? scene.layers : []) {
      if (layer?.kind !== 'text') continue;
      const size = Number(layer?.typography?.sizePx);
      const boxWidth = Number(layer?.transform?.width), boxHeight = Number(layer?.transform?.height);
      if (!(size > 0) || !(boxWidth > 0) || !(boxHeight > 0)) continue;
      const fit = estimateTextFit({
        text: String(layer?.content?.text ?? ''),
        fontSizePx: size,
        boxWidthPx: boxWidth,
        boxHeightPx: boxHeight,
        lineHeight: Number(layer?.typography?.lineHeight) || 1.15,
        maxLines: Number.isInteger(layer?.typography?.maxLines) ? layer.typography.maxLines : Infinity
      });
      if (fit && fit.fits === false) {
        findings.push({
          code: 'REFLOW_TEXT_OVERFLOW',
          severity: 'medium',
          sceneId: scene.id,
          layerId: layer.id,
          message: 'Reflowed text layer ' + layer.id + ' overflows its box at ' + size + ' px; enlarge the box or shorten the copy.',
          timeRangeFrames: { startFrame: scene.startFrame, endFrame: scene.startFrame + scene.durationFrames }
        });
      }
    }
  }
  return { findings, passed: findings.length === 0 };
}

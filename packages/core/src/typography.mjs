const BASE_SCALE = { hero: 108, sceneHeading: 72, supportingHeadline: 50, body: 36, caption: 27, footnote: 20 };

export function calculateTypeScale({ width = 1920, height = 1080, overrides = {} } = {}) {
  if (!(width > 0 && height > 0)) throw new Error('Canvas width and height must be positive.');
  const scale = Math.min(width / 1920, height / 1080);
  const result = {};
  for (const [role, base] of Object.entries(BASE_SCALE)) result[role] = Math.max(14, Math.round((overrides[role] ?? base) * scale));
  return { canvas: { width, height }, scale: Number(scale.toFixed(4)), sizesPx: result, note: 'Starting scale only. Validate actual text fit, glyph coverage and safe areas for each scene.' };
}

export function estimateTextFit({ text, fontSizePx, boxWidthPx, boxHeightPx, lineHeight = 1.15, averageGlyphWidth = 0.54, maxLines = Infinity }) {
  if (typeof text !== 'string' || !(fontSizePx > 0) || !(boxWidthPx > 0) || !(boxHeightPx > 0)) throw new Error('Text and positive fontSizePx/boxWidthPx/boxHeightPx are required.');
  const charsPerLine = Math.max(1, Math.floor(boxWidthPx / (fontSizePx * averageGlyphWidth)));
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1, current = 0;
  for (const word of words) {
    const extra = (current ? 1 : 0) + word.length;
    if (current + extra > charsPerLine) { lines += 1; current = word.length; }
    else current += extra;
  }
  const requiredHeightPx = lines * fontSizePx * lineHeight;
  const fits = lines <= maxLines && requiredHeightPx <= boxHeightPx;
  return { fits, estimatedLines: lines, charsPerLine, requiredHeightPx: Math.ceil(requiredHeightPx), availableHeightPx: boxHeightPx, recommendation: fits ? 'fit' : 'increase text box, shorten copy, or revise composition before reducing the font size.' };
}

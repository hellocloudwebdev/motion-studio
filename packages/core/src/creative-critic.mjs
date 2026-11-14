import { registryEntryFor } from './patch.mjs';

// Creative critique (P3.4). Structured advisory review of the finished cut
// against the brief across six dimensions. Findings are advisory by
// construction: severity is capped at medium so they never flip the
// deterministic pass gate, `canOverrideDeterministicGates` is always false and
// they can never waive rights, timing, media integrity or renderer checks.
// Repairable findings carry a registered defect code and ride the same
// bounded repair cycle as deterministic defects; subjective findings are
// recorded and surfaced, never silently dropped.

export const CREATIVE_DIMENSIONS = new Set(['brief-alignment', 'hook', 'pacing', 'continuity', 'art-direction', 'cta']);

// Registered defect codes a creative finding may request; anything else is
// subjective-only. Both codes repair *consistency* against declared brand
// state, never creative intent itself.
export const REPAIRABLE_CREATIVE_CODES = new Set(['CREATIVE_TYPOGRAPHY_INCONSISTENT', 'CREATIVE_MOTION_PRESET_MISSING']);

const SEVERITY_RANK = { critical: 1, high: 2, medium: 3, low: 4 };
const CTA_VERBS = ['visit', 'try', 'get', 'start', 'subscribe', 'buy', 'learn', 'download', 'sign up', 'signup', 'contact', 'shop', 'book', 'order', 'join', 'donate', 'read', 'watch', 'listen', 'follow', 'share'];
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'your', 'you', 'our', 'from', 'have', 'will', 'are', 'was', 'into', 'about', 'their', 'them', 'they', 'what', 'when', 'how', 'why', 'who', 'all', 'any', 'can', 'not', 'but', 'its', 'it\'s', 'more', 'than', 'then', 'now', 'new', 'one', 'two']);

function clampSeverity(value) {
  const rank = SEVERITY_RANK[value];
  if (!rank) return 'medium';
  return rank < SEVERITY_RANK.medium ? 'medium' : value;
}

function contentWords(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function narrationOf(scene) {
  const narration = scene?.production?.narration;
  if (typeof narration === 'string' && narration.trim()) return narration.trim();
  const cues = Array.isArray(scene?.audioCues) ? scene.audioCues : [];
  return cues.map(cue => (typeof cue?.text === 'string' ? cue.text : '')).join(' ').trim();
}

function headlineOf(scene) {
  const layer = (Array.isArray(scene?.layers) ? scene.layers : []).find(item => item?.kind === 'text' && typeof item?.content?.text === 'string' && item.content.text.trim());
  return layer ? layer.content.text.trim() : '';
}

function scenesOf(project) {
  return Array.isArray(project?.scenes) ? project.scenes : [];
}

function fpsOf(project) {
  const rate = project?.project?.frameRate;
  const numerator = Number(rate?.numerator), denominator = Number(rate?.denominator);
  if (!(numerator > 0) || !(denominator > 0)) return null;
  return numerator / denominator;
}

function sceneStartFrame(project, sceneId) {
  const scene = scenesOf(project).find(item => item?.id === sceneId);
  return scene && Number.isInteger(scene.startFrame) ? scene.startFrame : null;
}

function frameAtSecondsFor(project, sceneId) {
  const fps = fpsOf(project), startFrame = sceneStartFrame(project, sceneId);
  if (fps === null || startFrame === null) return null;
  return Math.round((startFrame / fps) * 1000) / 1000;
}

function timeRangeFramesFor(project, sceneId) {
  const scene = scenesOf(project).find(item => item?.id === sceneId);
  if (!scene || !Number.isInteger(scene.startFrame) || !Number.isInteger(scene.durationFrames)) return null;
  return { startFrame: scene.startFrame, endFrame: scene.startFrame + scene.durationFrames };
}

function finding({ dimension, severity, summary, sceneId, project, suggestion, defectCode, evidence = {} }) {
  // Consistency repairs are art-direction territory: hints attached to
  // subjective dimensions (hook, pacing, …) are dropped at normalization.
  const hint = dimension === 'art-direction' && defectCode && REPAIRABLE_CREATIVE_CODES.has(defectCode)
    ? { defectCode, sceneId: sceneId ?? null }
    : null;
  return {
    id: 'creative-' + dimension + '-' + (evidence.index ?? 'x'),
    dimension,
    severity: clampSeverity(severity),
    summary: String(summary || 'Unspecified creative review note.'),
    evidence: {
      ...(sceneId ? { sceneId } : {}),
      ...(frameAtSecondsFor(project, sceneId) !== null ? { frameAtSeconds: frameAtSecondsFor(project, sceneId) } : {}),
      ...(timeRangeFramesFor(project, sceneId) ? { timeRangeFrames: timeRangeFramesFor(project, sceneId) } : {}),
      ...evidence
    },
    suggestion: suggestion ? String(suggestion) : null,
    repairHint: hint,
    advisoryOnly: true
  };
}

// Deterministic offline provider: every finding is a pure function of the
// Canonical Video IR, so the same project always critiques identically.
export function heuristicCreativeCritique({ project } = {}) {
  const findings = [];
  const scenes = scenesOf(project);
  const brief = project?.creative || {};
  const objectiveWords = contentWords([brief.message, project?.project?.objective, brief.concept].join(' '));
  const brandFonts = new Set([project?.brand?.fonts?.display, project?.brand?.fonts?.body].filter(Boolean).map(f => String(f)));
  const brandTextColors = new Set([project?.brand?.colors?.text].filter(Boolean).map(c => String(c).toLowerCase()));
  const declaredPreset = typeof project?.production?.designSystem?.motionPreset === 'string' && project.production.designSystem.motionPreset.trim()
    ? project.production.designSystem.motionPreset.trim() : null;
  const fps = fpsOf(project);
  let index = 0;
  const nextIndex = () => ++index;

  for (const scene of scenes) {
    // Brief/message alignment: a scene whose narration shares no content words
    // with the brief is off-message (subjective; never auto-repaired).
    const narration = narrationOf(scene);
    const words = contentWords(narration);
    if (objectiveWords.length && words.length && !words.some(word => objectiveWords.includes(word))) {
      findings.push(finding({
        dimension: 'brief-alignment', severity: 'medium', sceneId: scene.id, project,
        evidence: { index: nextIndex() },
        summary: 'Scene narration "' + narration.slice(0, 80) + (narration.length > 80 ? '…' : '') + '" shares no content words with the declared brief message.',
        suggestion: 'Rewrite the scene narration to reference the brief message vocabulary.'
      }));
    }
    // Art direction: typography and motion consistency against the declared
    // brand (the two repairable dimensions).
    for (const layer of Array.isArray(scene?.layers) ? scene.layers : []) {
      if (layer?.kind !== 'text') continue;
      const family = layer?.typography?.family;
      if (brandFonts.size && typeof family === 'string' && family.trim() && !brandFonts.has(family.trim())) {
        findings.push(finding({
          dimension: 'art-direction', severity: 'medium', sceneId: scene.id, project,
          evidence: { index: nextIndex(), layerId: layer.id, family },
          summary: 'Text layer ' + layer.id + ' uses font "' + family + '" outside the declared brand fonts (' + [...brandFonts].join(', ') + ').',
          suggestion: 'Set the layer family to the brand display font.',
          defectCode: 'CREATIVE_TYPOGRAPHY_INCONSISTENT'
        }));
      }
      const color = layer?.style?.color;
      if (brandTextColors.size && typeof color === 'string' && color.trim() && !brandTextColors.has(color.trim().toLowerCase())) {
        findings.push(finding({
          dimension: 'art-direction', severity: 'low', sceneId: scene.id, project,
          evidence: { index: nextIndex(), layerId: layer.id, color },
          summary: 'Text layer ' + layer.id + ' uses color ' + color + ' outside the declared brand text color.',
          suggestion: 'Align the layer color with the brand text color.'
        }));
      }
      const preset = layer?.motion?.preset;
      if (declaredPreset && (!preset || preset === 'none') && scenes.length > 1) {
        findings.push(finding({
          dimension: 'art-direction', severity: 'medium', sceneId: scene.id, project,
          evidence: { index: nextIndex(), layerId: layer.id },
          summary: 'Text layer ' + layer.id + ' has no motion preset while the design system declares "' + declaredPreset + '".',
          suggestion: 'Apply the declared motion preset to the layer.',
          defectCode: 'CREATIVE_MOTION_PRESET_MISSING'
        }));
      }
    }
  }

  // Hook: the first scene must earn attention (subjective).
  const first = scenes[0];
  if (first) {
    const hookWords = contentWords(headlineOf(first) + ' ' + narrationOf(first)).length;
    if (hookWords < 8) {
      findings.push(finding({
        dimension: 'hook', severity: 'medium', sceneId: first.id, project,
        evidence: { index: nextIndex() },
        summary: 'Opening scene carries only ' + hookWords + ' content words; the hook is likely too thin to stop the scroll.',
        suggestion: 'Strengthen the opening headline or narration.'
      }));
    }
  }

  // Pacing: segment lengths against readable narration tempo (subjective).
  if (fps !== null) {
    for (const scene of scenes) {
      const seconds = scene.durationFrames / fps;
      if (seconds < 1.2) {
        findings.push(finding({
          dimension: 'pacing', severity: 'medium', sceneId: scene.id, project,
          evidence: { index: nextIndex(), seconds: Math.round(seconds * 1000) / 1000 },
          summary: 'Scene ' + scene.id + ' lasts ' + (Math.round(seconds * 100) / 100) + 's; too short for the narration to register.',
          suggestion: 'Extend the scene or trim its narration.'
        }));
      } else if (seconds > 12) {
        findings.push(finding({
          dimension: 'pacing', severity: 'medium', sceneId: scene.id, project,
          evidence: { index: nextIndex(), seconds: Math.round(seconds * 1000) / 1000 },
          summary: 'Scene ' + scene.id + ' lasts ' + (Math.round(seconds * 100) / 100) + 's; attention typically drops before it ends.',
          suggestion: 'Split the scene or tighten its copy.'
        }));
      }
    }
  }

  // Continuity: adjacent scenes that change background AND motion language at
  // once read as a visual jump (subjective).
  for (let i = 1; i < scenes.length; i += 1) {
    const previous = scenes[i - 1], current = scenes[i];
    const backgroundOf = scene => (Array.isArray(scene?.layers) ? scene.layers : []).find(layer => layer?.kind === 'shape')?.style?.backgroundColor ?? null;
    const presetOf = scene => (Array.isArray(scene?.layers) ? scene.layers : []).find(layer => layer?.motion?.preset)?.motion?.preset ?? null;
    const backgroundChanged = backgroundOf(previous) && backgroundOf(current) && backgroundOf(previous) !== backgroundOf(current);
    const motionChanged = presetOf(previous) && presetOf(current) && presetOf(previous) !== presetOf(current);
    if (backgroundChanged && motionChanged) {
      findings.push(finding({
        dimension: 'continuity', severity: 'low', sceneId: current.id, project,
        evidence: { index: nextIndex(), previousSceneId: previous.id },
        summary: 'Scenes ' + previous.id + ' → ' + current.id + ' change background color and motion preset simultaneously.',
        suggestion: 'Carry one visual anchor across the cut.'
      }));
    }
  }

  // CTA: when the brief implies an action, the final scene should carry one
  // (subjective).
  const last = scenes[scenes.length - 1];
  if (last && objectiveWords.length) {
    const closing = (headlineOf(last) + ' ' + narrationOf(last)).toLowerCase();
    const briefImpliesAction = CTA_VERBS.some(verb => String(project?.project?.objective || '').toLowerCase().includes(verb));
    if (briefImpliesAction && !CTA_VERBS.some(verb => closing.includes(verb))) {
      findings.push(finding({
        dimension: 'cta', severity: 'medium', sceneId: last.id, project,
        evidence: { index: nextIndex() },
        summary: 'The brief objective implies an action, but the closing scene carries no call to action.',
        suggestion: 'Add an explicit closing CTA line.'
      }));
    }
  }

  return { provider: 'deterministic-heuristics', verdict: findings.length ? 'review' : 'pass', findings };
}

// Provider-based critique entry point. The provider is opt-in and explicitly
// supplied; its findings are validated and normalized — severity capped at
// medium, unknown dimensions rejected, repair hints restricted to registered
// consistency codes.
export async function runCreativeCritique({ provider, project, signal } = {}) {
  if (typeof provider !== 'function') throw new Error('Creative critique is opt-in and requires an explicitly supplied provider function.');
  if (!project || typeof project !== 'object') throw new Error('Creative critique requires a Canonical Video IR project.');
  const response = await provider({ project, signal });
  if (!response || typeof response !== 'object' || !['pass', 'review', 'fail'].includes(response.verdict)) throw new Error('Creative critique returned an invalid verdict.');
  const findings = Array.isArray(response.findings) ? response.findings : [];
  const normalized = findings.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Creative critique produced a non-object finding.');
    if (!CREATIVE_DIMENSIONS.has(item.dimension)) throw new Error('Creative critique produced an unknown dimension: ' + String(item.dimension));
    if (typeof item.summary !== 'string' || !item.summary.trim()) throw new Error('Creative critique produced a finding without a summary.');
    return finding({
      dimension: item.dimension,
      severity: item.severity,
      summary: item.summary,
      sceneId: typeof item.sceneId === 'string' ? item.sceneId : (typeof item.evidence?.sceneId === 'string' ? item.evidence.sceneId : null),
      project,
      suggestion: item.suggestion,
      defectCode: item.repairHint?.defectCode ?? item.defectCode,
      evidence: { ...(item.evidence && typeof item.evidence === 'object' ? item.evidence : {}), index: item.evidence?.index ?? item.id ?? undefined }
    });
  });
  const unresolvedRepairable = normalized.filter(item => item.repairHint && !registryEntryFor(item.repairHint.defectCode).op);
  for (const item of unresolvedRepairable) item.repairHint = null;
  return {
    provider: String(response.provider || 'user-supplied'),
    verdict: normalized.length && response.verdict === 'pass' ? 'review' : response.verdict,
    advisoryOnly: true,
    canOverrideDeterministicGates: false,
    findings: normalized,
    createdAt: new Date().toISOString()
  };
}

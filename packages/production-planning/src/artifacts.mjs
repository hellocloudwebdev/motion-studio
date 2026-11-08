import { validateProject } from '../../core/src/validate-project.mjs';

const issue = (code, path, message, severity = 'error') => ({ code, path, message, severity });
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const FRAME_RATES = new Set(['24/1', '25/1', '30/1', '50/1', '60/1', '24000/1001', '30000/1001', '60000/1001']);
const DIMENSIONS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 }
};

export function validateResearchEvidence(evidence) {
  const issues = [];
  if (!isObject(evidence)) return { valid: false, issues: [issue('RESEARCH_NOT_OBJECT', '$', 'Research evidence must be an object.')] };
  if (evidence.schemaVersion !== '1.0.0') issues.push(issue('RESEARCH_VERSION', '$.schemaVersion', 'Expected research evidence schemaVersion 1.0.0.'));
  if (!Array.isArray(evidence.sources)) issues.push(issue('RESEARCH_SOURCES', '$.sources', 'sources must be an array.'));
  if (!Array.isArray(evidence.claims)) issues.push(issue('RESEARCH_CLAIMS', '$.claims', 'claims must be an array.'));
  const sourceIds = new Set();
  for (const [index, source] of (Array.isArray(evidence.sources) ? evidence.sources : []).entries()) {
    const path = '$.sources[' + index + ']';
    if (!isObject(source) || !nonEmpty(source.id) || !nonEmpty(source.url) || !nonEmpty(source.title)) {
      issues.push(issue('RESEARCH_SOURCE_FIELDS', path, 'Each source requires id, title and URL.'));
      continue;
    }
    if (sourceIds.has(source.id)) issues.push(issue('RESEARCH_DUPLICATE_SOURCE', path + '.id', 'Source IDs must be unique.'));
    sourceIds.add(source.id);
    try {
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol)) issues.push(issue('RESEARCH_SOURCE_URL', path + '.url', 'Research source URLs must use HTTP or HTTPS.'));
    } catch {
      issues.push(issue('RESEARCH_SOURCE_URL', path + '.url', 'Research source URL is invalid.'));
    }
  }
  const claimIds = new Set();
  for (const [index, claim] of (Array.isArray(evidence.claims) ? evidence.claims : []).entries()) {
    const path = '$.claims[' + index + ']';
    if (!isObject(claim) || !nonEmpty(claim.id) || !nonEmpty(claim.text) || !Array.isArray(claim.sourceIds) || claim.sourceIds.length === 0) {
      issues.push(issue('RESEARCH_CLAIM_FIELDS', path, 'Each factual claim requires id, text and at least one sourceId.'));
      continue;
    }
    if (claimIds.has(claim.id)) issues.push(issue('RESEARCH_DUPLICATE_CLAIM', path + '.id', 'Claim IDs must be unique.'));
    claimIds.add(claim.id);
    for (const id of claim.sourceIds) if (!sourceIds.has(id)) issues.push(issue('RESEARCH_UNSUPPORTED_CLAIM', path + '.sourceIds', 'Claim references unknown source ' + String(id) + '.'));
  }
  return { valid: !issues.some(item => item.severity === 'error'), issues };
}

export function validatePlanningArtifacts({ brief, creativeDirection, script, storyboard, designSystem, researchEvidence } = {}) {
  const issues = [];
  if (!isObject(brief)) issues.push(issue('BRIEF_REQUIRED', '$.brief', 'A validated production brief is required.'));
  if (!isObject(creativeDirection)) issues.push(issue('CREATIVE_DIRECTION_REQUIRED', '$.creativeDirection', 'Creative direction artifact is required.'));
  else {
    for (const field of ['concept', 'message']) if (!nonEmpty(creativeDirection[field])) issues.push(issue('CREATIVE_DIRECTION_FIELD', '$.creativeDirection.' + field, field + ' must be non-empty.'));
    if (creativeDirection.mood !== undefined && !Array.isArray(creativeDirection.mood)) issues.push(issue('CREATIVE_MOOD', '$.creativeDirection.mood', 'mood must be an array.'));
  }
  if (!isObject(script)) issues.push(issue('SCRIPT_REQUIRED', '$.script', 'Script artifact is required.'));
  else {
    if (!nonEmpty(script.narration) && !Array.isArray(script.narrationSegments)) issues.push(issue('SCRIPT_NARRATION', '$.script.narration', 'Provide narration text or narrationSegments.'));
    if (!Array.isArray(script.onScreenCopy)) issues.push(issue('SCRIPT_ON_SCREEN_COPY', '$.script.onScreenCopy', 'onScreenCopy must be an array.'));
    if (script.cta !== undefined && !nonEmpty(script.cta)) issues.push(issue('SCRIPT_CTA', '$.script.cta', 'cta must be non-empty when provided.'));
  }
  if (!isObject(storyboard) || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    issues.push(issue('STORYBOARD_REQUIRED', '$.storyboard.scenes', 'Storyboard must contain at least one scene.'));
  } else {
    const sceneIds = new Set();
    storyboard.scenes.forEach((scene, index) => {
      const path = '$.storyboard.scenes[' + index + ']';
      if (!isObject(scene) || !nonEmpty(scene.id) || !nonEmpty(scene.name) || !nonEmpty(scene.intent)) {
        issues.push(issue('STORYBOARD_SCENE_FIELDS', path, 'Each scene requires id, name and intent.'));
        return;
      }
      if (sceneIds.has(scene.id)) issues.push(issue('STORYBOARD_DUPLICATE_SCENE', path + '.id', 'Scene IDs must be unique.'));
      sceneIds.add(scene.id);
      if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) issues.push(issue('STORYBOARD_SCENE_DURATION', path + '.durationFrames', 'durationFrames must be a positive integer.'));
      if (!Array.isArray(scene.layers)) issues.push(issue('STORYBOARD_LAYERS', path + '.layers', 'layers must be an array.'));
      else scene.layers.forEach((layer, layerIndex) => {
        if (!isObject(layer) || !nonEmpty(layer.id) || !nonEmpty(layer.kind)) issues.push(issue('STORYBOARD_LAYER_FIELDS', path + '.layers[' + layerIndex + ']', 'Each layer requires id and kind.'));
      });
    });
  }
  if (!isObject(designSystem)) issues.push(issue('DESIGN_SYSTEM_REQUIRED', '$.designSystem', 'Design system artifact is required.'));
  else {
    if (!isObject(designSystem.colors)) issues.push(issue('DESIGN_COLORS', '$.designSystem.colors', 'colors must be an object of named color tokens.'));
    if (!Array.isArray(designSystem.fonts) || designSystem.fonts.length === 0) issues.push(issue('DESIGN_FONTS', '$.designSystem.fonts', 'At least one font declaration is required.'));
    if (designSystem.safeAreaPercent !== undefined && (!Number.isFinite(designSystem.safeAreaPercent) || designSystem.safeAreaPercent < 0 || designSystem.safeAreaPercent > 25)) issues.push(issue('DESIGN_SAFE_AREA', '$.designSystem.safeAreaPercent', 'safeAreaPercent must be between 0 and 25.'));
  }
  if (isObject(brief)) {
    if (!nonEmpty(brief.audience)) issues.push(issue('BRIEF_AUDIENCE_UNRESOLVED', '$.brief.audience', 'Audience must be resolved before compiling the Canonical Video IR.'));
    if (!Number.isFinite(brief.durationSeconds) || brief.durationSeconds <= 0) issues.push(issue('BRIEF_DURATION_UNRESOLVED', '$.brief.durationSeconds', 'A positive target duration is required before compilation.'));
    if (!['16:9', '9:16', '1:1', '4:5', 'custom'].includes(brief.aspectRatio)) issues.push(issue('BRIEF_ASPECT_UNRESOLVED', '$.brief.aspectRatio', 'Resolve aspectRatio to a supported value before compilation.'));
    if (brief.research?.required === true) {
      const result = validateResearchEvidence(researchEvidence);
      issues.push(...result.issues.map(item => ({ ...item, path: '$.researchEvidence' + item.path.slice(1) })));
    }
  }
  return { valid: !issues.some(item => item.severity === 'error'), issues };
}

function dimensionsFor(brief) {
  if (brief.aspectRatio === 'custom') return brief.customDimensions;
  return DIMENSIONS[brief.aspectRatio];
}

function frameRateFor(brief) {
  const frameRate = brief.frameRate || { numerator: 30, denominator: 1 };
  const key = frameRate.numerator + '/' + frameRate.denominator;
  if (!Number.isInteger(frameRate.numerator) || !Number.isInteger(frameRate.denominator) || !FRAME_RATES.has(key)) {
    throw new Error('Unsupported or invalid frameRate. Use 24, 25, 30, 50, 60, 24000/1001, 30000/1001 or 60000/1001.');
  }
  return frameRate;
}

export function compilePlanningArtifacts(input) {
  const validation = validatePlanningArtifacts(input);
  if (!validation.valid) {
    const error = new Error('Planning artifacts are not ready for Canonical Video IR compilation.');
    error.issues = validation.issues;
    throw error;
  }
  const { brief, creativeDirection, script, storyboard, designSystem, researchEvidence } = input;
  const dimensions = dimensionsFor(brief);
  if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error('Aspect ratio requires valid output dimensions.');
  }
  const frameRate = frameRateFor(brief);
  const totalFrames = Math.round(brief.durationSeconds * frameRate.numerator / frameRate.denominator);
  const sceneFrames = storyboard.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);
  if (Math.abs(sceneFrames - totalFrames) > 1) {
    throw new Error('Storyboard duration (' + sceneFrames + ' frames) must match target duration (' + totalFrames + ' frames) within one frame.');
  }
  let startFrame = 0;
  const scenes = storyboard.scenes.map(scene => {
    const compiled = {
      id: scene.id,
      name: scene.name,
      startFrame,
      durationFrames: scene.durationFrames,
      intent: scene.intent,
      transitionIn: scene.transitionIn,
      transitionOut: scene.transitionOut,
      camera: scene.camera,
      layers: scene.layers,
      audioCues: scene.audioCues || []
    };
    startFrame += scene.durationFrames;
    return compiled;
  });
  const target = {
    id: 'master-' + brief.aspectRatio.replace(':', 'x'),
    format: 'mp4',
    width: dimensions.width,
    height: dimensions.height,
    frameRate,
    videoCodec: 'libx264',
    audioCodec: 'aac',
    colorSpace: 'Rec.709',
    alpha: false,
    platform: brief.platform || undefined
  };
  const project = {
    schemaVersion: '1.0.0',
    project: {
      id: brief.id,
      name: nonEmpty(brief.title) ? brief.title : brief.idea.slice(0, 80),
      objective: brief.purpose || brief.idea,
      frameRate,
      canvas: { ...dimensions, pixelAspectRatio: 1, safeAreaPercent: designSystem.safeAreaPercent ?? 5 },
      totalDurationFrames: totalFrames,
      colorSpace: 'Rec.709',
      createdAt: brief.createdAt,
      revision: 1
    },
    creative: {
      concept: creativeDirection.concept,
      audience: brief.audience,
      message: creativeDirection.message,
      mood: creativeDirection.mood || [],
      visualDirection: creativeDirection.visualDirection || '',
      references: brief.references || []
    },
    brand: {
      colors: designSystem.colors,
      fonts: designSystem.fonts,
      rules: designSystem.rules || []
    },
    assets: brief.suppliedAssets.map(asset => ({ ...asset })),
    scenes,
    delivery: { targets: [target], primaryTargetId: target.id },
    provenance: {
      sources: researchEvidence?.sources || [],
      decisions: [
        { type: 'brief', id: brief.id },
        { type: 'planning-artifacts', status: 'compiled' },
        ...(brief.frameRate ? [] : [{ type: 'technical-default', field: 'frameRate', value: frameRate, reason: '30 fps default' }])
      ]
    },
    planning: { script, researchEvidence: researchEvidence || null }
  };
  const projectValidation = validateProject(project);
  if (!projectValidation.valid) {
    const error = new Error('Compiled Canonical Video IR failed project validation.');
    error.issues = projectValidation.issues;
    throw error;
  }
  return { project, validation: projectValidation, summary: { sceneCount: scenes.length, totalDurationFrames: totalFrames, frameRate, canvas: dimensions, researchSources: researchEvidence?.sources?.length || 0 } };
}

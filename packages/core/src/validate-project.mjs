const ENGINE_HINTS = new Set(['after-effects', 'hyperframes', 'blender', 'threejs', 'ffmpeg', 'auto']);
const LAYER_KINDS = new Set(['text', 'shape', 'image', 'video', '3d', 'camera', 'effect', 'audio', 'chart', 'particle', 'composite', 'other']);
const issue = (code, path, message, severity = 'error') => ({ code, path, message, severity });

export function validateProject(project) {
  const issues = [];
  if (!project || typeof project !== 'object' || Array.isArray(project)) return { valid: false, issues: [issue('PROJECT_NOT_OBJECT', '$', 'Project must be a JSON object.')] };
  if (project.schemaVersion !== '1.0.0') issues.push(issue('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', `Expected schemaVersion 1.0.0; received ${String(project.schemaVersion)}.`));
  const p = project.project;
  if (!p || typeof p !== 'object') issues.push(issue('PROJECT_METADATA_MISSING', '$.project', 'Project metadata is required.'));
  else {
    for (const key of ['id', 'name', 'objective']) if (typeof p[key] !== 'string' || !p[key].trim()) issues.push(issue('REQUIRED_FIELD', `$.project.${key}`, `${key} must be a non-empty string.`));
    const fr = p.frameRate;
    if (!fr || !Number.isInteger(fr.numerator) || fr.numerator <= 0 || !Number.isInteger(fr.denominator) || fr.denominator <= 0) issues.push(issue('INVALID_FRAME_RATE', '$.project.frameRate', 'Frame rate must use positive integer numerator and denominator values.'));
    const canvas = p.canvas;
    if (!canvas || !Number.isInteger(canvas.width) || canvas.width <= 0 || !Number.isInteger(canvas.height) || canvas.height <= 0) issues.push(issue('INVALID_CANVAS', '$.project.canvas', 'Canvas width and height must be positive integers.'));
    if (!Number.isInteger(p.totalDurationFrames) || p.totalDurationFrames <= 0) issues.push(issue('INVALID_TOTAL_DURATION', '$.project.totalDurationFrames', 'totalDurationFrames must be a positive integer.'));
  }
  if (project.assets !== undefined && !Array.isArray(project.assets)) issues.push(issue('ASSETS_NOT_ARRAY', '$.assets', 'assets must be an array when provided.'));
  else if (Array.isArray(project.assets)) {
    const assetIds = new Set();
    project.assets.forEach((asset, index) => {
      const ap = '$.assets[' + index + ']';
      if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || !asset.id.trim()) issues.push(issue('ASSET_ID_REQUIRED', ap + '.id', 'Each asset needs a non-empty id.'));
      else if (assetIds.has(asset.id)) issues.push(issue('DUPLICATE_ASSET_ID', ap + '.id', 'Duplicate asset id: ' + asset.id + '.'));
      else assetIds.add(asset.id);
      if (asset && asset.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(asset.sha256)) issues.push(issue('INVALID_ASSET_CHECKSUM', ap + '.sha256', 'Asset SHA-256 must contain 64 hexadecimal characters.'));
    });
    for (const [sceneIndex, scene] of (project.scenes || []).entries()) for (const [layerIndex, layer] of (scene.layers || []).entries()) {
      if (layer?.assetId && !assetIds.has(layer.assetId)) issues.push(issue('ASSET_REFERENCE_UNRESOLVED', '$.scenes[' + sceneIndex + '].layers[' + layerIndex + '].assetId', 'Layer references an asset that is not attached to this project: ' + layer.assetId + '.', 'warning'));
    }
  }
  const c = project.creative;
  if (!c || typeof c !== 'object') issues.push(issue('CREATIVE_BRIEF_MISSING', '$.creative', 'Creative brief is required.'));
  else for (const key of ['concept', 'audience', 'message']) if (typeof c[key] !== 'string' || !c[key].trim()) issues.push(issue('REQUIRED_FIELD', `$.creative.${key}`, `${key} must be a non-empty string.`));
  if (!Array.isArray(project.scenes) || project.scenes.length === 0) issues.push(issue('SCENES_REQUIRED', '$.scenes', 'At least one scene is required.'));
  else {
    const sceneIds = new Set(), layerIds = new Set(); let knownSceneFrames = 0;
    project.scenes.forEach((scene, si) => {
      const sp = `$.scenes[${si}]`;
      if (!scene || typeof scene !== 'object') { issues.push(issue('INVALID_SCENE', sp, 'Scene must be an object.')); return; }
      for (const key of ['id', 'name', 'intent']) if (typeof scene[key] !== 'string' || !scene[key].trim()) issues.push(issue('REQUIRED_FIELD', `${sp}.${key}`, `${key} must be a non-empty string.`));
      if (scene.id) { if (sceneIds.has(scene.id)) issues.push(issue('DUPLICATE_SCENE_ID', `${sp}.id`, `Duplicate scene id: ${scene.id}.`)); sceneIds.add(scene.id); }
      if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) issues.push(issue('INVALID_SCENE_DURATION', `${sp}.durationFrames`, 'Scene durationFrames must be a positive integer.'));
      else knownSceneFrames += scene.durationFrames;
      if (!Array.isArray(scene.layers)) issues.push(issue('LAYERS_REQUIRED', `${sp}.layers`, 'Scene layers must be an array.'));
      else scene.layers.forEach((layer, li) => {
        const lp = `${sp}.layers[${li}]`;
        if (!layer || typeof layer !== 'object') { issues.push(issue('INVALID_LAYER', lp, 'Layer must be an object.')); return; }
        if (typeof layer.id !== 'string' || !layer.id.trim()) issues.push(issue('REQUIRED_FIELD', `${lp}.id`, 'Layer id must be a non-empty string.'));
        else { if (layerIds.has(layer.id)) issues.push(issue('DUPLICATE_LAYER_ID', `${lp}.id`, `Duplicate layer id: ${layer.id}.`)); layerIds.add(layer.id); }
        if (!LAYER_KINDS.has(layer.kind)) issues.push(issue('UNKNOWN_LAYER_KIND', `${lp}.kind`, `Unsupported layer kind: ${String(layer.kind)}.`));
        if (layer.engineHint && !ENGINE_HINTS.has(layer.engineHint)) issues.push(issue('UNKNOWN_ENGINE_HINT', `${lp}.engineHint`, `Unsupported engine hint: ${layer.engineHint}.`));
        if (layer.startFrame !== undefined && (!Number.isInteger(layer.startFrame) || layer.startFrame < 0)) issues.push(issue('INVALID_LAYER_START', `${lp}.startFrame`, 'startFrame must be a non-negative integer.'));
        if (layer.durationFrames !== undefined && (!Number.isInteger(layer.durationFrames) || layer.durationFrames <= 0)) issues.push(issue('INVALID_LAYER_DURATION', `${lp}.durationFrames`, 'durationFrames must be a positive integer.'));
        if (layer.kind === 'text' && (!layer.typography || typeof layer.typography.family !== 'string' || !layer.typography.family.trim() || !(Number(layer.typography.sizePx) > 0))) issues.push(issue('TEXT_TYPOGRAPHY_INCOMPLETE', `${lp}.typography`, 'Text layers need a font family and positive sizePx.', 'warning'));
      });
    });
    if (p && Number.isInteger(p.totalDurationFrames) && knownSceneFrames > p.totalDurationFrames) issues.push(issue('SCENES_EXCEED_PROJECT_DURATION', '$.scenes', `Sum of scene durations (${knownSceneFrames}) exceeds totalDurationFrames (${p.totalDurationFrames}).`));
  }
  if (!project.delivery || !Array.isArray(project.delivery.targets) || project.delivery.targets.length === 0) issues.push(issue('DELIVERY_TARGET_REQUIRED', '$.delivery.targets', 'At least one delivery target is required.'));
  else project.delivery.targets.forEach((target, i) => { if (!target || !Number.isInteger(target.width) || target.width <= 0 || !Number.isInteger(target.height) || target.height <= 0) issues.push(issue('INVALID_DELIVERY_DIMENSIONS', `$.delivery.targets[${i}]`, 'Delivery target needs positive integer width and height.')); });
  const errors = issues.filter(x => x.severity === 'error');
  return { valid: errors.length === 0, issues, summary: { errors: errors.length, warnings: issues.length - errors.length } };
}

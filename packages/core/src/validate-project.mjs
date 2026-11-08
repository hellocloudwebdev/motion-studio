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
  const c = project.creative;
  if (!c || typeof c !== 'object') issues.push(issue('CREATIVE_BRIEF_MISSING', '$.creative', 'Creative brief is required.'));
  else for (const key of ['concept', 'audience', 'message']) if (typeof c[key] !== 'string' || !c[key].trim()) issues.push(issue('REQUIRED_FIELD', `$.creative.${key}`, `${key} must be a non-empty string.`));
  if (!Array.isArray(project.scenes) || project.scenes.length === 0) issues.push(issue('SCENES_REQUIRED', '$.scenes', 'At least one scene is required.'));
  else {
    const sceneIds = new Set(), layerIds = new Set(); let knownSceneFrames = 0, implicitSceneStart = 0;
    project.scenes.forEach((scene, si) => {
      const sp = `$.scenes[${si}]`;
      if (!scene || typeof scene !== 'object') { issues.push(issue('INVALID_SCENE', sp, 'Scene must be an object.')); return; }
      for (const key of ['id', 'name', 'intent']) if (typeof scene[key] !== 'string' || !scene[key].trim()) issues.push(issue('REQUIRED_FIELD', `${sp}.${key}`, `${key} must be a non-empty string.`));
      if (scene.id) { if (sceneIds.has(scene.id)) issues.push(issue('DUPLICATE_SCENE_ID', `${sp}.id`, `Duplicate scene id: ${scene.id}.`)); sceneIds.add(scene.id); }
      if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) issues.push(issue('INVALID_SCENE_DURATION', `${sp}.durationFrames`, 'Scene durationFrames must be a positive integer.'));
      else knownSceneFrames += scene.durationFrames;
      const sceneStart = scene.startFrame === undefined ? implicitSceneStart : scene.startFrame;
      if (!Number.isInteger(sceneStart) || sceneStart < 0) issues.push(issue('INVALID_SCENE_START', `${sp}.startFrame`, 'startFrame must be a non-negative integer.'));
      else if (Number.isInteger(scene.durationFrames) && Number.isInteger(p?.totalDurationFrames) && sceneStart + scene.durationFrames > p.totalDurationFrames) issues.push(issue('SCENE_EXCEEDS_PROJECT_DURATION', sp, 'Scene end frame exceeds totalDurationFrames.'));
      if (Number.isInteger(scene.durationFrames)) implicitSceneStart = Math.max(implicitSceneStart, sceneStart + scene.durationFrames);
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
        const layerStart = layer.startFrame ?? 0, layerDuration = layer.durationFrames ?? scene.durationFrames;
        if (Number.isInteger(layerStart) && layerStart >= 0 && Number.isInteger(layerDuration) && Number.isInteger(scene.durationFrames) && layerStart + layerDuration > scene.durationFrames) issues.push(issue('LAYER_EXCEEDS_SCENE_DURATION', lp, 'Layer end frame exceeds its scene duration.'));
        if (layer.kind === 'text' && (!layer.typography || typeof layer.typography.family !== 'string' || !layer.typography.family.trim() || !(Number(layer.typography.sizePx) > 0))) issues.push(issue('TEXT_TYPOGRAPHY_INCOMPLETE', `${lp}.typography`, 'Text layers need a font family and positive sizePx.', 'warning'));
      });
      if (scene.audioCues !== undefined && !Array.isArray(scene.audioCues)) issues.push(issue('INVALID_AUDIO_CUES', `${sp}.audioCues`, 'audioCues must be an array.'));
      else for (const [ai, cue] of (scene.audioCues || []).entries()) validateAudioCue(cue, `${sp}.audioCues[${ai}]`, issues, scene.durationFrames, project.assets || []);
    });
    if (p && Number.isInteger(p.totalDurationFrames) && knownSceneFrames > p.totalDurationFrames) issues.push(issue('SCENES_EXCEED_PROJECT_DURATION', '$.scenes', `Sum of scene durations (${knownSceneFrames}) exceeds totalDurationFrames (${p.totalDurationFrames}).`));
  }
  if (project.audio?.tracks !== undefined && !Array.isArray(project.audio.tracks)) issues.push(issue('INVALID_AUDIO_TRACKS', '$.audio.tracks', 'audio.tracks must be an array.'));
  else for (const [ai, cue] of (project.audio?.tracks || []).entries()) validateAudioCue(cue, `$.audio.tracks[${ai}]`, issues, p?.totalDurationFrames, project.assets || []);
  if (!project.delivery || !Array.isArray(project.delivery.targets) || project.delivery.targets.length === 0) issues.push(issue('DELIVERY_TARGET_REQUIRED', '$.delivery.targets', 'At least one delivery target is required.'));
  else project.delivery.targets.forEach((target, i) => {
    const tp = `$.delivery.targets[${i}]`;
    if (!target || !Number.isInteger(target.width) || target.width <= 0 || !Number.isInteger(target.height) || target.height <= 0) issues.push(issue('INVALID_DELIVERY_DIMENSIONS', tp, 'Delivery target needs positive integer width and height.'));
    const rate = target?.frameRate;
    if (!rate || !Number.isInteger(rate.numerator) || rate.numerator <= 0 || !Number.isInteger(rate.denominator) || rate.denominator <= 0) issues.push(issue('INVALID_DELIVERY_FRAME_RATE', `${tp}.frameRate`, 'Delivery frameRate must use positive integer numerator and denominator values.'));
  });
  const errors = issues.filter(x => x.severity === 'error');
  return { valid: errors.length === 0, issues, summary: { errors: errors.length, warnings: issues.length - errors.length } };
}

function validateAudioCue(cue, at, issues, durationFrames, assets) {
  if (!cue || typeof cue !== 'object' || typeof cue.assetId !== 'string' || !cue.assetId.trim()) { issues.push(issue('AUDIO_ASSET_REQUIRED', at, 'Audio cue needs an assetId.')); return; }
  const asset = assets.find(item => item?.id === cue.assetId);
  if (!asset || asset.kind !== 'audio') issues.push(issue('AUDIO_ASSET_UNRESOLVED', at + '.assetId', 'Audio cue must reference an audio asset declared in the project.'));
  const start = cue.offsetFrames ?? cue.startFrame ?? 0;
  if (!Number.isInteger(start) || start < 0) issues.push(issue('INVALID_AUDIO_OFFSET', at + '.offsetFrames', 'Audio offset must be a non-negative integer frame count.'));
  if (cue.durationFrames !== undefined && (!Number.isInteger(cue.durationFrames) || cue.durationFrames <= 0 || Number.isInteger(start) && Number.isInteger(durationFrames) && start + cue.durationFrames > durationFrames)) issues.push(issue('INVALID_AUDIO_DURATION', at + '.durationFrames', 'Audio duration must be positive and remain inside its containing timeline.'));
  if (cue.volume !== undefined && (!Number.isFinite(cue.volume) || cue.volume < 0 || cue.volume > 4)) issues.push(issue('INVALID_AUDIO_VOLUME', at + '.volume', 'Audio volume must be between 0 and 4.'));
}

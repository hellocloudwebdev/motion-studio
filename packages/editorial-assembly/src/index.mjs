const MEDIA_KINDS = new Set(['video', 'audio', 'image']);
const TRACK_FAMILY = { video: 'V', audio: 'A', image: 'G', text: 'G', shape: 'G', effect: 'G', chart: 'G', particle: 'G', composite: 'G', '3d': 'G', camera: 'G', other: 'G' };

const issue = (code, path, message, severity = 'error') => ({ code, path, message, severity });

function validProject(project) {
  const errors = [];
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    errors.push(issue('PROJECT_REQUIRED', '$', 'A Canonical Video IR project object is required.'));
    return errors;
  }
  const fps = project.project?.frameRate;
  if (!Number.isInteger(fps?.numerator) || fps.numerator <= 0 || !Number.isInteger(fps?.denominator) || fps.denominator <= 0) {
    errors.push(issue('INVALID_FRAME_RATE', '$.project.frameRate', 'Frame rate must be a positive integer rational.'));
  }
  if (!Number.isInteger(project.project?.totalDurationFrames) || project.project.totalDurationFrames <= 0) {
    errors.push(issue('INVALID_PROJECT_DURATION', '$.project.totalDurationFrames', 'Project duration must be a positive integer frame count.'));
  }
  if (!Array.isArray(project.scenes) || project.scenes.length === 0) {
    errors.push(issue('SCENES_REQUIRED', '$.scenes', 'At least one scene is required.'));
  }
  return errors;
}

function allocateTrack(tracks, startFrame, endFrame) {
  let index = tracks.findIndex(track => track.endFrame <= startFrame);
  if (index < 0) {
    index = tracks.length;
    tracks.push({ endFrame: 0 });
  }
  tracks[index].endFrame = endFrame;
  return index + 1;
}

function assetMap(project) {
  return new Map((Array.isArray(project.assets) ? project.assets : []).filter(asset => asset && typeof asset.id === 'string').map(asset => [asset.id, asset]));
}

/**
 * Build a deterministic, frame-accurate editorial assembly plan from Canonical Video IR.
 * This is a planning/interchange artifact; it does not mutate IR or control Premiere.
 */
export function createEditorialAssembly(project, options = {}) {
  const issues = validProject(project);
  if (issues.length) return { valid: false, issues, summary: { errors: issues.length, warnings: 0 } };

  const fps = project.project.frameRate;
  const frameRate = { numerator: fps.numerator, denominator: fps.denominator };
  const projectFrames = project.project.totalDurationFrames;
  const assets = assetMap(project);
  const laneState = { video: [], audio: [], graphics: [] };
  const clips = [];
  const scenes = [];
  let cursor = 0;
  const seenSceneIds = new Set();
  const seenLayerIds = new Set();

  project.scenes.forEach((scene, sceneIndex) => {
    const scenePath = '$.scenes[' + sceneIndex + ']';
    if (!scene || typeof scene !== 'object' || typeof scene.id !== 'string' || !scene.id.trim()) {
      issues.push(issue('SCENE_ID_REQUIRED', scenePath + '.id', 'Every scene needs a non-empty id.'));
      return;
    }
    if (seenSceneIds.has(scene.id)) issues.push(issue('DUPLICATE_SCENE_ID', scenePath + '.id', 'Scene ids must be unique.'));
    seenSceneIds.add(scene.id);
    if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) {
      issues.push(issue('INVALID_SCENE_DURATION', scenePath + '.durationFrames', 'Scene duration must be a positive integer frame count.'));
      return;
    }
    const sceneStart = cursor;
    const sceneEnd = sceneStart + scene.durationFrames;
    scenes.push({ sceneId: scene.id, name: scene.name || scene.id, startFrame: sceneStart, endFrame: sceneEnd, durationFrames: scene.durationFrames });
    if (!Array.isArray(scene.layers)) {
      issues.push(issue('LAYERS_REQUIRED', scenePath + '.layers', 'Scene layers must be an array.'));
      cursor = sceneEnd;
      return;
    }

    scene.layers.forEach((layer, layerIndex) => {
      const layerPath = scenePath + '.layers[' + layerIndex + ']';
      if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || !layer.id.trim()) {
        issues.push(issue('LAYER_ID_REQUIRED', layerPath + '.id', 'Every layer needs a non-empty id.'));
        return;
      }
      if (seenLayerIds.has(layer.id)) issues.push(issue('DUPLICATE_LAYER_ID', layerPath + '.id', 'Layer ids must be unique across the project.'));
      seenLayerIds.add(layer.id);
      const localStart = layer.startFrame ?? 0;
      const duration = layer.durationFrames ?? (scene.durationFrames - localStart);
      if (!Number.isInteger(localStart) || localStart < 0 || !Number.isInteger(duration) || duration <= 0 || localStart + duration > scene.durationFrames) {
        issues.push(issue('LAYER_OUTSIDE_SCENE', layerPath, 'Layer startFrame and durationFrames must fit within the scene duration.'));
        return;
      }
      const kind = TRACK_FAMILY[layer.kind] ? layer.kind : 'other';
      const family = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : kind === 'image' ? 'graphics' : 'graphics';
      const startFrame = sceneStart + localStart;
      const endFrame = startFrame + duration;
      const trackNumber = allocateTrack(laneState[family], startFrame, endFrame);
      const asset = layer.assetId ? assets.get(layer.assetId) : null;
      const clip = {
        clipId: layer.id, sceneId: scene.id, name: layer.name || layer.id,
        kind: layer.kind || 'other', family, track: family === 'video' ? 'V' + trackNumber : family === 'audio' ? 'A' + trackNumber : 'G' + trackNumber,
        startFrame, endFrame, durationFrames: duration,
        sourceInFrame: Number.isInteger(layer.sourceInFrame) && layer.sourceInFrame >= 0 ? layer.sourceInFrame : 0,
        assetId: layer.assetId || null,
        sourceUri: asset?.uri || null,
        sourceSha256: asset?.sha256 || null,
        rightsStatus: asset?.metadata?.rightsStatus || (asset ? 'needs-review' : null),
        media: MEDIA_KINDS.has(layer.kind)
      };
      if (layer.assetId && !asset) issues.push(issue('ASSET_UNRESOLVED', layerPath + '.assetId', 'No attached asset record exists for ' + layer.assetId + '.', 'warning'));
      if (asset && asset.metadata?.rightsStatus !== 'approved') issues.push(issue('ASSET_RIGHTS_REVIEW_REQUIRED', layerPath + '.assetId', 'Asset ' + asset.id + ' has not been marked approved in producer rights-review metadata.', 'warning'));
      if (MEDIA_KINDS.has(layer.kind) && !layer.assetId) issues.push(issue('MEDIA_ASSET_REQUIRED', layerPath + '.assetId', 'Media layers need an assetId to resolve source media.', 'warning'));
      clips.push(clip);
    });
    cursor = sceneEnd;
  });

  if (cursor > projectFrames) issues.push(issue('ASSEMBLY_EXCEEDS_PROJECT', '$.scenes', 'Sequential scene duration (' + cursor + ' frames) exceeds project duration (' + projectFrames + ' frames).'));
  if (cursor < projectFrames) issues.push(issue('ASSEMBLY_SHORTER_THAN_PROJECT', '$.scenes', 'Sequential scene duration (' + cursor + ' frames) is shorter than project duration (' + projectFrames + ' frames).', 'warning'));

  const errors = issues.filter(item => item.severity === 'error');
  const warnings = issues.filter(item => item.severity === 'warning');
  const orderedClips = clips.sort((a, b) => a.startFrame - b.startFrame || a.track.localeCompare(b.track) || a.clipId.localeCompare(b.clipId));
  return {
    assemblyVersion: '1.0.0',
    project: { id: project.project.id, name: project.project.name, revision: project.project.revision ?? 1, totalDurationFrames: projectFrames, frameRate },
    sequence: { id: project.project.id + '-sequence', name: options.sequenceName || project.project.name || project.project.id, startFrame: 0, endFrame: cursor, durationFrames: cursor },
    scenes,
    tracks: Object.entries(laneState).flatMap(([family, lanes]) => lanes.map((lane, index) => ({ id: (family === 'video' ? 'V' : family === 'audio' ? 'A' : 'G') + (index + 1), family, index: index + 1 }))),
    clips: orderedClips,
    issues,
    summary: { valid: errors.length === 0, errors: errors.length, warnings: warnings.length, sceneCount: scenes.length, clipCount: clips.length, trackCount: Object.values(laneState).reduce((sum, lanes) => sum + lanes.length, 0), mediaClipCount: clips.filter(clip => clip.media).length }
  };
}

export function validateEditorialAssembly(assembly) {
  const issues = [];
  if (!assembly || assembly.assemblyVersion !== '1.0.0' || !Array.isArray(assembly.clips) || !Array.isArray(assembly.scenes)) {
    return { valid: false, issues: [issue('INVALID_ASSEMBLY', '$', 'Expected assemblyVersion 1.0.0 with scenes and clips arrays.')] };
  }
  const ids = new Set();
  for (const [index, clip] of assembly.clips.entries()) {
    if (!clip || typeof clip.clipId !== 'string' || !clip.clipId.trim()) issues.push(issue('CLIP_ID_REQUIRED', '$.clips[' + index + '].clipId', 'Every clip needs an id.'));
    else if (ids.has(clip.clipId)) issues.push(issue('DUPLICATE_CLIP_ID', '$.clips[' + index + '].clipId', 'Clip ids must be unique.'));
    else ids.add(clip.clipId);
    if (!Number.isInteger(clip.startFrame) || !Number.isInteger(clip.endFrame) || clip.startFrame < 0 || clip.endFrame <= clip.startFrame) issues.push(issue('INVALID_CLIP_RANGE', '$.clips[' + index + ']', 'Clip range must be a positive integer frame interval.'));
    if (!/^[VAG][1-9][0-9]*$/.test(clip.track || '')) issues.push(issue('INVALID_TRACK_ID', '$.clips[' + index + '].track', 'Track id must be Vn, An or Gn.'));
  }
  return { valid: issues.length === 0, issues, summary: { errors: issues.length } };
}

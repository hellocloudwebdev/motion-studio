import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function resolveLocalAudio(sourceRoot, uri) {
  if (typeof uri !== 'string' || !uri.trim() || uri.includes('\\') || uri.includes('\0') || uri.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(uri) || /^[a-z]:/i.test(uri) || uri.split('/').includes('..')) {
    throw new Error('Audio asset URI must be a project-relative local path without traversal or a remote scheme.');
  }
  const root = await realpath(sourceRoot), resolved = await realpath(path.resolve(root, uri));
  if (!contained(root, resolved)) throw new Error('Resolved audio asset escapes the project directory.');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Audio asset must resolve to a regular file.');
  return resolved;
}

export async function audioInputsFromProject(project, projectFile) {
  if (!project?.project?.frameRate || !Array.isArray(project.assets)) throw new Error('Audio routing requires a project with assets and a rational frame rate.');
  const rate = project.project.frameRate;
  if (!Number.isInteger(rate.numerator) || rate.numerator <= 0 || !Number.isInteger(rate.denominator) || rate.denominator <= 0) throw new Error('Audio routing requires a positive rational frame rate.');
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const sourceRoot = path.dirname(path.resolve(projectFile));
  const sources = [...(project.audio?.tracks || []).map(cue => ({ cue, baseFrame: 0 }))];
  let nextSceneFrame = 0;
  for (const scene of project.scenes || []) {
    const baseFrame = scene.startFrame ?? nextSceneFrame;
    for (const cue of scene.audioCues || []) sources.push({ cue, baseFrame });
    if (Number.isInteger(scene.durationFrames)) nextSceneFrame = Math.max(nextSceneFrame, baseFrame + scene.durationFrames);
  }
  const secondsPerFrame = rate.denominator / rate.numerator;
  const result = [];
  for (const [index, { cue, baseFrame }] of sources.entries()) {
    const asset = assets.get(cue?.assetId);
    if (!asset || asset.kind !== 'audio') throw new Error('Audio cue ' + index + ' references an unresolved audio asset: ' + cue?.assetId);
    const localOffset = Number(cue.offsetFrames ?? cue.startFrame ?? 0);
    if (!Number.isInteger(localOffset) || localOffset < 0) throw new Error('Audio cue ' + index + ' offset must be a non-negative integer frame count.');
    const file = await resolveLocalAudio(sourceRoot, asset.uri);
    result.push({
      path: file,
      kind: cue.kind || cue.role || 'audio',
      offsetSeconds: (baseFrame + localOffset) * secondsPerFrame,
      volume: cue.volume ?? 1,
      ...(cue.durationFrames === undefined ? {} : { durationSeconds: cue.durationFrames * secondsPerFrame }),
      ...(cue.fadeInFrames === undefined ? {} : { fadeInSeconds: cue.fadeInFrames * secondsPerFrame }),
      ...(cue.fadeOutFrames === undefined ? {} : { fadeOutSeconds: cue.fadeOutFrames * secondsPerFrame }),
      duckAgainstNarration: cue.duckAgainstNarration === true
    });
  }
  return result;
}

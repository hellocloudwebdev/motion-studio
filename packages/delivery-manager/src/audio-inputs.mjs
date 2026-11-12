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

function rateOf(project) {
  if (!project?.project?.frameRate || !Array.isArray(project.assets)) throw new Error('Audio routing requires a project with assets and a rational frame rate.');
  const rate = project.project.frameRate;
  if (!Number.isInteger(rate.numerator) || rate.numerator <= 0 || !Number.isInteger(rate.denominator) || rate.denominator <= 0) throw new Error('Audio routing requires a positive rational frame rate.');
  return rate;
}

// Audio cue sources on the absolute project timeline: project tracks start at
// frame 0, scene cues at their scene's declared or cumulative start frame.
function cueSources(project) {
  const sources = [...(project.audio?.tracks || []).map(cue => ({ cue, baseFrame: 0 }))];
  let nextSceneFrame = 0;
  for (const scene of project.scenes || []) {
    const baseFrame = scene.startFrame ?? nextSceneFrame;
    for (const cue of scene.audioCues || []) sources.push({ cue, baseFrame });
    if (Number.isInteger(scene.durationFrames)) nextSceneFrame = Math.max(nextSceneFrame, baseFrame + scene.durationFrames);
  }
  return sources;
}

async function toAudioInputs(project, projectFile, clip = null) {
  const rate = rateOf(project);
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const sourceRoot = path.dirname(path.resolve(projectFile));
  const secondsPerFrame = rate.denominator / rate.numerator;
  const result = [];
  for (const [index, { cue, baseFrame }] of cueSources(project).entries()) {
    const localOffset = Number(cue?.offsetFrames ?? cue?.startFrame ?? 0);
    if (!Number.isInteger(localOffset) || localOffset < 0) throw new Error('Audio cue ' + index + ' offset must be a non-negative integer frame count.');
    const cueStart = baseFrame + localOffset;
    const cueEnd = Number.isInteger(cue?.durationFrames) && cue.durationFrames > 0 ? cueStart + cue.durationFrames : Number.POSITIVE_INFINITY;
    // Range re-basing (repair retests): cues outside the requested frame range
    // are skipped before asset resolution so unrelated cues cannot fail it.
    const asset = assets.get(cue?.assetId);
    if (clip && (cueEnd <= clip.startFrame || clip.endFrame <= cueStart)) continue;
    if (!asset || asset.kind !== 'audio') throw new Error('Audio cue ' + index + ' references an unresolved audio asset: ' + cue?.assetId);
    const file = await resolveLocalAudio(sourceRoot, asset.uri);
    if (!clip) {
      result.push({
        path: file,
        kind: cue.kind || cue.role || 'audio',
        offsetSeconds: cueStart * secondsPerFrame,
        volume: cue.volume ?? 1,
        ...(cue.durationFrames === undefined ? {} : { durationSeconds: cue.durationFrames * secondsPerFrame }),
        ...(cue.fadeInFrames === undefined ? {} : { fadeInSeconds: cue.fadeInFrames * secondsPerFrame }),
        ...(cue.fadeOutFrames === undefined ? {} : { fadeOutSeconds: cue.fadeOutFrames * secondsPerFrame }),
        duckAgainstNarration: cue.duckAgainstNarration === true
      });
      continue;
    }
    const fromFrame = Math.max(cueStart, clip.startFrame);
    const toFrame = Math.min(cueEnd, clip.endFrame);
    const clippedFrames = toFrame - fromFrame;
    if (!(clippedFrames > 0)) continue;
    // Fades that already played before the range (fade-in) or were cut off by
    // the range end (fade-out) shrink to whatever remains inside the segment.
    const playedFrames = fromFrame - cueStart;
    const fadeInFrames = Math.max(0, Math.min(Number(cue.fadeInFrames ?? 0) - playedFrames, clippedFrames));
    const fadeOutFrames = Math.max(0, Math.min(Number(cue.fadeOutFrames ?? 0) - Math.max(0, cueEnd - toFrame), clippedFrames - fadeInFrames));
    result.push({
      path: file,
      kind: cue.kind || cue.role || 'audio',
      offsetSeconds: (fromFrame - clip.startFrame) * secondsPerFrame,
      volume: cue.volume ?? 1,
      durationSeconds: clippedFrames * secondsPerFrame,
      ...(fadeInFrames > 0 ? { fadeInSeconds: fadeInFrames * secondsPerFrame } : {}),
      ...(fadeOutFrames > 0 ? { fadeOutSeconds: fadeOutFrames * secondsPerFrame } : {}),
      duckAgainstNarration: cue.duckAgainstNarration === true
    });
  }
  return result;
}

export async function audioInputsFromProject(project, projectFile) {
  return toAudioInputs(project, projectFile, null);
}

// Repair-retest variant: audio inputs for the cues intersecting the global
// frame range [startFrame, endFrame), re-based so offsetSeconds is relative to
// the range start and durations/fades are clipped to it. Used to re-run AUDIO_*
// analyses on a rendered scene segment (design §4.2 step 10).
export async function audioInputsFromProjectRange(project, projectFile, { startFrame, endFrame } = {}) {
  if (!Number.isInteger(startFrame) || startFrame < 0 || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new Error('Audio range re-basing requires a non-empty integer frame range with startFrame < endFrame.');
  }
  return toAudioInputs(project, projectFile, { startFrame, endFrame });
}

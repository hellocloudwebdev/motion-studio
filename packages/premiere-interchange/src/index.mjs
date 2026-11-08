import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { validateEditorialAssembly } from '../../editorial-assembly/src/index.mjs';

const issue = (code, pathName, message, severity = 'error') => ({ code, path: pathName, message, severity });
const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
function frameTime(frames, rate) {
  if (frames === 0) return '0s';
  const numerator = frames * rate.denominator;
  const divisor = gcd(numerator, rate.numerator);
  return (numerator / divisor) + '/' + (rate.numerator / divisor) + 's';
}
function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}
async function sha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function resolveMediaUri(uri, assetRoot) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('Media clip has no source URI.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password) throw new Error('Premiere interchange accepts local file: media URIs only.');
    const resolved = await realpath(fileURLToPath(parsed));
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('Media source URI must resolve to a regular file.');
    return pathToFileURL(resolved).href;
  }
  if (!assetRoot || !path.isAbsolute(assetRoot)) throw new Error('Relative media paths require an absolute --asset-root.');
  const root = await realpath(assetRoot);
  const candidate = path.resolve(root, uri);
  if (!isWithin(root, candidate)) throw new Error('Media path escapes the configured asset root.');
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error('Resolved media path escapes the configured asset root.');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Media source must resolve to a regular file.');
  return pathToFileURL(resolved).href;
}

/**
 * Export a validated editorial assembly as a deterministic FCPXML interchange document.
 * This creates XML and a provenance sidecar only; it does not launch or edit Premiere.
 */
export async function exportPremiereInterchange(assembly, options = {}) {
  const validation = validateEditorialAssembly(assembly);
  if (!validation.valid) return { valid: false, issues: validation.issues, xml: null, manifest: null };
  const rate = assembly.project?.frameRate;
  if (!Number.isInteger(rate?.numerator) || rate.numerator <= 0 || !Number.isInteger(rate?.denominator) || rate.denominator <= 0) {
    return { valid: false, issues: [issue('INVALID_FRAME_RATE', '$.project.frameRate', 'A positive rational frame rate is required.')], xml: null, manifest: null };
  }
  const duration = assembly.sequence?.durationFrames;
  if (!Number.isInteger(duration) || duration <= 0) {
    return { valid: false, issues: [issue('INVALID_SEQUENCE_DURATION', '$.sequence.durationFrames', 'A positive integer sequence duration is required.')], xml: null, manifest: null };
  }
  const issues = [];
  for (const [index, clip] of assembly.clips.entries()) {
    if (clip.startFrame < 0 || clip.endFrame > duration || clip.durationFrames !== clip.endFrame - clip.startFrame || !Number.isInteger(clip.sourceInFrame || 0) || (clip.sourceInFrame || 0) < 0) {
      issues.push(issue('CLIP_OUTSIDE_SEQUENCE', '$.clips[' + index + ']', 'Clip frame range and source in-point must be valid and fit within the sequence.'));
    }
  }
  if (issues.length) return { valid: false, issues, xml: null, manifest: null };
  const mediaClips = assembly.clips.filter(clip => clip.media === true);
  const unsupported = assembly.clips.filter(clip => clip.media !== true);
  for (const clip of unsupported) issues.push(issue('UNSUPPORTED_CLIP_KIND', '$.clips.' + clip.clipId, 'Non-media clip ' + clip.clipId + ' is retained in the sidecar but not represented in FCPXML.', 'warning'));
  const tracks = [...new Set(mediaClips.map(clip => clip.track))].sort();
  const laneByTrack = new Map(tracks.map((track, index) => [track, index + 1]));
  const resourceByKey = new Map();
  const resources = [];
  const clipRows = [];
  for (const clip of mediaClips) {
    if (!/^[a-f0-9]{64}$/i.test(clip.sourceSha256 || '')) {
      issues.push(issue('SOURCE_CHECKSUM_REQUIRED', '$.clips.' + clip.clipId + '.sourceSha256', 'A valid SHA-256 source checksum is required for media interchange.'));
      continue;
    }
    try {
      const src = await resolveMediaUri(clip.sourceUri, options.assetRoot);
      const actualHash = await sha256(fileURLToPath(src));
      if (actualHash !== clip.sourceSha256.toLowerCase()) throw new Error('Media source SHA-256 does not match the editorial assembly manifest.');
      const key = src + ':' + clip.sourceSha256.toLowerCase();
      if (!resourceByKey.has(key)) {
        const id = 'r' + (resources.length + 2);
        resourceByKey.set(key, id);
        resources.push({ id, src, sha256: clip.sourceSha256.toLowerCase(), name: clip.name, kind: clip.kind, durationFrames: (clip.sourceInFrame || 0) + clip.durationFrames });
      } else {
        const resource = resources.find(item => item.id === resourceByKey.get(key));
        resource.durationFrames = Math.max(resource.durationFrames, (clip.sourceInFrame || 0) + clip.durationFrames);
      }
      clipRows.push({ ...clip, resourceId: resourceByKey.get(key) });
    } catch (error) {
      issues.push(issue('MEDIA_SOURCE_UNRESOLVED', '$.clips.' + clip.clipId + '.sourceUri', error.message));
    }
  }
  if (issues.some(item => item.severity === 'error')) return { valid: false, issues, xml: null, manifest: null };
  const width = Number.isInteger(options.width) && options.width > 0 ? options.width : 1920;
  const height = Number.isInteger(options.height) && options.height > 0 ? options.height : 1080;
  const formatId = 'r1';
  const resourceXml = [
    '<format id="' + formatId + '" name="Motion Studio ' + width + 'x' + height + '" frameDuration="' + frameTime(1, rate) + '" width="' + width + '" height="' + height + '"/>',
    ...resources.map(resource => '<asset id="' + resource.id + '" name="' + escapeXml(resource.name) + '" src="' + escapeXml(resource.src) + '" start="0s" duration="' + frameTime(resource.durationFrames, rate) + '" format="' + formatId + '" hasVideo="' + (resource.kind === 'audio' ? '0' : '1') + '" hasAudio="' + (resource.kind === 'audio' || resource.kind === 'video' ? '1' : '0') + '"/>')
  ].join('');
  const clipXml = clipRows.sort((a, b) => a.startFrame - b.startFrame || a.track.localeCompare(b.track) || a.clipId.localeCompare(b.clipId)).map(clip =>
    '<asset-clip ref="' + clip.resourceId + '" name="' + escapeXml(clip.name) + '" lane="' + laneByTrack.get(clip.track) + '" offset="' + frameTime(clip.startFrame, rate) + '" start="' + frameTime(clip.sourceInFrame || 0, rate) + '" duration="' + frameTime(clip.durationFrames, rate) + '"/>'
  ).join('');
  const sequenceName = options.sequenceName || assembly.sequence.name || assembly.project.name || 'Motion Studio Sequence';
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>' + resourceXml + '</resources><library><event name="Motion Studio"><project name="' + escapeXml(sequenceName) + '"><sequence format="' + formatId + '" duration="' + frameTime(duration, rate) + '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine><gap name="' + escapeXml(sequenceName) + '" offset="0s" duration="' + frameTime(duration, rate) + '">' + clipXml + '</gap></spine></sequence></project></event></library></fcpxml>\n';
  const manifest = {
    interchangeVersion: '1.0.0-alpha.1',
    format: 'FCPXML 1.10',
    project: assembly.project,
    sequence: assembly.sequence,
    resources,
    clips: clipRows.map(clip => ({
      clipId: clip.clipId, sceneId: clip.sceneId, track: clip.track,
      startFrame: clip.startFrame, endFrame: clip.endFrame,
      sourceInFrame: clip.sourceInFrame || 0, durationFrames: clip.durationFrames,
      sourceUri: clip.sourceUri, resolvedUri: resources.find(item => item.id === clip.resourceId)?.src,
      sourceSha256: clip.sourceSha256, rightsStatus: clip.rightsStatus
    })),
    unsupportedClips: unsupported.map(clip => ({ clipId: clip.clipId, kind: clip.kind, startFrame: clip.startFrame, endFrame: clip.endFrame })),
    warnings: issues
  };
  return { valid: true, issues, xml, manifest };
}

import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finalizeMedia, renderCaptions, runMediaCommand } from '../../ffmpeg/src/index.mjs';

function hashFile(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safeFilename(value) { return String(value || 'asset').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'asset'; }
function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Delivery path must be inside the project delivery folder.');
  return target;
}

export async function buildDeliveryPackage({ project, projectFile, sourceVideo, projectRoot, outputRoot, renderManifest, audioInputs = [], signal } = {}) {
  if (!project?.project?.id || !project?.delivery?.targets?.length) throw new Error('A valid project and at least one output profile are required.');
  const source = path.resolve(sourceVideo), root = path.resolve(projectRoot), packageRoot = path.resolve(outputRoot || path.join(root, 'deliverables'));
  await access(source); await mkdir(packageRoot, { recursive: true });
  const primary = project.delivery.targets.find(x => x.id === project.delivery.primaryTargetId) || project.delivery.targets[0];
  const variants = [];
  for (const target of project.delivery.targets) {
    const fps = target.frameRate.numerator / target.frameRate.denominator;
    const extension = target.format === 'mov' || target.format === 'prores' ? 'mov' : target.format === 'webm' ? 'webm' : 'mp4';
    const output = assertInside(packageRoot, path.join(packageRoot, project.project.id + '-' + target.id + '.' + extension));
    if (!['mp4', 'mov', 'prores', 'webm'].includes(target.format)) throw new Error('Unsupported video delivery format: ' + target.format);
    const defaultVideoCodec = target.format === 'webm' ? 'libvpx-vp9' : target.format === 'prores' ? 'prores_ks' : 'libx264';
    const defaultAudioCodec = target.format === 'webm' ? 'libopus' : target.format === 'prores' ? 'pcm_s16le' : 'aac';
    const durationSeconds = project.project.totalDurationFrames * project.project.frameRate.denominator / project.project.frameRate.numerator;
    const receipt = await finalizeMedia({ input: source, output, width: target.width, height: target.height, fps, durationSeconds, videoCodec: target.videoCodec || defaultVideoCodec, audioCodec: target.audioCodec || defaultAudioCodec, crf: target.crf ?? 18, audioInputs, audioRequired: Boolean(target.audioRequired), signal });
    variants.push({ target, ...receipt });
  }
  const primaryVideo = variants.find(variant => variant.target.id === primary.id)?.output || variants[0].output;
  const thumbnail = assertInside(packageRoot, path.join(packageRoot, 'thumbnail.jpg'));
  await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', primaryVideo, '-frames:v', '1', '-q:v', '2', thumbnail], { signal });
  const thumbnailStat = await stat(thumbnail);
  if (thumbnailStat.size === 0) throw new Error('FFmpeg produced an empty delivery thumbnail.');
  const captions = project.captions || project.script?.captions || [];
  const captionFiles = [];
  if (captions.length) {
    for (const format of ['srt', 'vtt']) {
      const file = assertInside(packageRoot, path.join(packageRoot, 'captions.' + format));
      await writeFile(file, renderCaptions(captions, project.project.frameRate, format), 'utf8');
      captionFiles.push(file);
    }
  }
  const assetRoot = assertInside(packageRoot, path.join(packageRoot, 'assets'));
  await mkdir(assetRoot, { recursive: true });
  const sourceProjectDir = path.dirname(path.resolve(projectFile || path.join(root, 'project.json')));
  const assetManifest = [];
  for (const asset of project.assets || []) {
    const entry = { ...asset, included: false };
    if (typeof asset.uri === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(asset.uri)) {
      const sourceAsset = path.resolve(sourceProjectDir, asset.uri);
      try {
        await access(sourceAsset);
        const extension = path.extname(sourceAsset).slice(0, 12);
        const targetAsset = assertInside(packageRoot, path.join(assetRoot, safeFilename(asset.id) + extension));
        await copyFile(sourceAsset, targetAsset);
        entry.included = true; entry.packagePath = path.relative(packageRoot, targetAsset); entry.sha256 = hashFile(await readFile(targetAsset));
      } catch { entry.unresolvedReason = 'Local source asset is missing or unreadable.'; }
    } else entry.unresolvedReason = 'Remote asset was not downloaded into the package.';
    assetManifest.push(entry);
  }
  const projectCopy = assertInside(packageRoot, path.join(packageRoot, 'project-source.json'));
  const projectBytes = await readFile(projectFile || path.join(root, 'project.json'));
  await writeFile(projectCopy, projectBytes);
  const manifestPath = path.join(packageRoot, 'asset-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ projectId: project.project.id, assets: assetManifest }, null, 2) + '\n');
  const rightsCleared = assetManifest.every(asset => ['cleared', 'user-owned'].includes(asset.rightsStatus) || asset.kind === 'generated');
  const assetsPackaged = assetManifest.every(asset => asset.included || asset.kind === 'generated');
  const canonicalIrSha256 = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const renderSourceMatches = renderManifest?.projectIrSha256 === canonicalIrSha256;
  const productionAccepted = renderManifest?.productionReady === true && renderManifest?.verified === true && renderSourceMatches && rightsCleared && assetsPackaged;
  const receipt = {
    schemaVersion: '1.0', projectId: project.project.id, projectRevision: project.project.revision || 1,
    createdAt: new Date().toISOString(),
    status: productionAccepted ? 'accepted' : 'packaged-awaiting-production-evidence',
    acceptance: { passed: productionAccepted, reason: productionAccepted ? null : !renderManifest?.productionReady ? 'A verified production-ready render manifest is required for acceptance.' : !renderSourceMatches ? 'Render evidence does not match the packaged Canonical Video IR.' : !rightsCleared ? 'Asset rights must be cleared or user-owned before acceptance.' : !assetsPackaged ? 'Every project asset must be included in the package or generated locally.' : 'Render evidence is incomplete.' },
    variants, thumbnail,
    captions: captionFiles, sourceProject: { path: projectCopy, sha256: hashFile(projectBytes), canonicalIrSha256 },
    assetManifest: manifestPath, provenance: project.provenance || { sources: [], software: [], decisions: [] },
    renderManifest: renderManifest || null, qaReport: project.qa || null,
    limitations: assetManifest.filter(asset => asset.included === false && !['generated'].includes(asset.kind)).map(asset => ({ assetId: asset.id, reason: 'Source asset is referenced in the project manifest but was not copied into this package.' }))
  };
  const receiptPath = assertInside(packageRoot, path.join(packageRoot, 'delivery-receipt.json'));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return { ...receipt, receiptPath };
}

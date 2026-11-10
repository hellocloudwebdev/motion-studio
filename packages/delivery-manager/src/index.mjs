import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finalizeMedia, renderCaptions, runMediaCommand } from '../../ffmpeg/src/index.mjs';
import { analyzeRenderedMedia } from '../../render-manager/src/media-analysis.mjs';

function hashFile(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safeFilename(value) { return String(value || 'asset').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'asset'; }
function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Delivery path must be inside the project delivery folder.');
  return target;
}

function referencedAssetIds(project) {
  const ids = new Set();
  for (const scene of project.scenes || []) {
    for (const layer of scene.layers || []) if (typeof layer.assetId === 'string') ids.add(layer.assetId);
    for (const cue of scene.audioCues || []) if (typeof cue.assetId === 'string') ids.add(cue.assetId);
  }
  for (const track of project.audio?.tracks || []) if (typeof track.assetId === 'string') ids.add(track.assetId);
  if (typeof project.brand?.logoAssetId === 'string') ids.add(project.brand.logoAssetId);
  return ids;
}

function safeRelativeAssetUri(uri) {
  return typeof uri === 'string' && uri.length > 0 && !uri.includes('\\') && !uri.includes('\0') && !uri.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:/i.test(uri) && !uri.split('/').includes('..');
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function assertNoSymlinkPath(root, target) {
  assertInside(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Delivery output path traverses a symbolic link: ' + current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}

async function resolveAssetFile(sourceProjectDir, uri) {
  if (!safeRelativeAssetUri(uri)) throw new Error('Referenced asset URI must be a project-relative path without traversal or a remote scheme.');
  const realRoot = await realpath(sourceProjectDir);
  const candidate = path.resolve(realRoot, uri);
  if (!contained(realRoot, candidate)) throw new Error('Referenced asset path escapes the project directory.');
  const resolved = await realpath(candidate);
  if (!contained(realRoot, resolved)) throw new Error('Resolved asset symlink escapes the project directory.');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Referenced asset must resolve to a regular file.');
  return resolved;
}

export async function buildDeliveryPackage({ project, projectFile, sourceVideo, projectRoot, outputRoot, renderManifest, editorialAssembly = null, operationHistory = [], audioInputs = [], signal } = {}) {
  if (!project?.project?.id || !project?.delivery?.targets?.length) throw new Error('A valid project and at least one output profile are required.');
  const source = path.resolve(sourceVideo), root = path.resolve(projectRoot);
  let packageRoot = path.resolve(outputRoot || path.join(root, 'deliverables'));
  await access(source); await mkdir(packageRoot, { recursive: true });
  packageRoot = await realpath(packageRoot);
  const primary = project.delivery.targets.find(x => x.id === project.delivery.primaryTargetId) || project.delivery.targets[0];
  const variants = [];
  for (const target of project.delivery.targets) {
    const fps = target.frameRate.numerator / target.frameRate.denominator;
    const extension = target.format === 'mov' || target.format === 'prores' ? 'mov' : target.format === 'webm' ? 'webm' : 'mp4';
    const output = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, project.project.id + '-' + target.id + '.' + extension));
    if (!['mp4', 'mov', 'prores', 'webm'].includes(target.format)) throw new Error('Unsupported video delivery format: ' + target.format);
    const defaultVideoCodec = target.format === 'webm' ? 'libvpx-vp9' : target.format === 'prores' ? 'prores_ks' : 'libx264';
    const defaultAudioCodec = target.format === 'webm' ? 'libopus' : target.format === 'prores' ? 'pcm_s16le' : 'aac';
    const durationSeconds = project.project.totalDurationFrames * project.project.frameRate.denominator / project.project.frameRate.numerator;
    const receipt = await finalizeMedia({ input: source, output, width: target.width, height: target.height, fps, durationSeconds, videoCodec: target.videoCodec || defaultVideoCodec, audioCodec: target.audioCodec || defaultAudioCodec, crf: target.crf ?? 18, audioInputs, audioRequired: Boolean(target.audioRequired), signal });
    const mediaAnalysis = await analyzeRenderedMedia({ input: output, media: receipt.media, options: { ocr: false }, signal });
    variants.push({ target, ...receipt, mediaAnalysis });
  }
  const primaryVideo = variants.find(variant => variant.target.id === primary.id)?.output || variants[0].output;
  const thumbnail = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'thumbnail.jpg'));
  await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', primaryVideo, '-frames:v', '1', '-q:v', '2', thumbnail], { signal });
  const thumbnailStat = await stat(thumbnail);
  if (thumbnailStat.size === 0) throw new Error('FFmpeg produced an empty delivery thumbnail.');
  const captions = project.captions || project.script?.captions || [];
  const captionFiles = [];
  if (captions.length) {
    for (const format of ['srt', 'vtt']) {
      const file = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'captions.' + format));
      await writeFile(file, renderCaptions(captions, project.project.frameRate, format), 'utf8');
      captionFiles.push(file);
    }
  }
  const assetRoot = assertInside(packageRoot, path.join(packageRoot, 'assets'));
  await mkdir(assetRoot, { recursive: true });
  await assertNoSymlinkPath(packageRoot, assetRoot);
  const sourceProjectDir = path.dirname(path.resolve(projectFile || path.join(root, 'project.json')));
  const assetManifest = [];
  const referencedIds = referencedAssetIds(project);
  const assetsById = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const portableProject = structuredClone(project);
  for (const id of referencedIds) {
    const asset = assetsById.get(id);
    if (!asset) { assetManifest.push({ id, included: false, rightsStatus: 'unknown', unresolvedReason: 'Referenced asset record is missing from Canonical Video IR.' }); continue; }
    const entry = { id: asset.id, kind: asset.kind, sourceUri: asset.uri, rightsStatus: asset.rightsStatus || asset.metadata?.rightsStatus || 'unknown', included: false };
    if (asset.kind === 'generated' && !asset.uri) {
      entry.included = true; entry.generated = true;
    } else {
      try {
        const resolved = await resolveAssetFile(sourceProjectDir, asset.uri);
        const bytes = await readFile(resolved), actualSha256 = hashFile(bytes);
        if (asset.sha256 && asset.sha256.toLowerCase() !== actualSha256) throw new Error('Asset SHA-256 does not match the Canonical Video IR.');
        const extension = path.extname(resolved).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '');
        const targetAsset = await assertNoSymlinkPath(packageRoot, path.join(assetRoot, safeFilename(asset.id) + '-' + actualSha256.slice(0, 8) + extension));
        await writeFile(targetAsset, bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        entry.included = true; entry.packagePath = path.relative(packageRoot, targetAsset).split(path.sep).join('/'); entry.sha256 = actualSha256; entry.byteSize = bytes.length;
        const portableAsset = portableProject.assets.find(item => item.id === id);
        if (portableAsset) { portableAsset.uri = entry.packagePath; portableAsset.sha256 = actualSha256; }
      } catch (error) { entry.unresolvedReason = error.message; }
    }
    assetManifest.push(entry);
  }
  const projectCopy = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'project-source.json'));
  const sourceProjectBytes = await readFile(projectFile || path.join(root, 'project.json'));
  await writeFile(projectCopy, sourceProjectBytes);
  const portableProjectPath = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'project-portable.json'));
  const portableProjectBytes = Buffer.from(JSON.stringify(portableProject, null, 2) + '\n');
  await writeFile(portableProjectPath, portableProjectBytes);
  const manifestPath = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'asset-manifest.json'));
  await writeFile(manifestPath, JSON.stringify({ projectId: project.project.id, assets: assetManifest }, null, 2) + '\n');
  const evidenceRoot = path.join(packageRoot, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  await assertNoSymlinkPath(packageRoot, evidenceRoot);
  const evidenceFiles = [];
  async function saveEvidence(name, value) {
    if (value === null || value === undefined) return null;
    const file = await assertNoSymlinkPath(packageRoot, path.join(evidenceRoot, name));
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await writeFile(file, bytes);
    evidenceFiles.push(file);
    return file;
  }
  const renderEvidencePath = await saveEvidence('render-manifest.json', renderManifest);
  const qaEvidencePath = await saveEvidence('qa-report.json', renderManifest?.qa || project.qa || null);
  const editorialEvidencePath = await saveEvidence('editorial-assembly.json', editorialAssembly);
  const operationHistoryPath = await saveEvidence('operation-history.json', operationHistory);
  const frameEvidence = Array.isArray(renderManifest?.frameEvidence) ? renderManifest.frameEvidence : [];
  const qaFramesDirectory = path.join(evidenceRoot, 'qa-frames');
  if (frameEvidence.length) {
    await mkdir(qaFramesDirectory, { recursive: true });
    await assertNoSymlinkPath(packageRoot, qaFramesDirectory);
    const allowedRoots = [path.resolve(root), path.resolve(path.dirname(source))];
    for (const [index, frame] of frameEvidence.entries()) {
      if (typeof frame?.path !== 'string') continue;
      const sourceFrame = path.resolve(frame.path);
      if (!allowedRoots.some(allowed => contained(allowed, sourceFrame))) throw new Error('QA frame evidence path escapes the render workspace.');
      const realFrame = await realpath(sourceFrame);
      if (!allowedRoots.some(allowed => contained(allowed, realFrame))) throw new Error('Resolved QA frame evidence escapes the render workspace.');
      const frameBytes = await readFile(realFrame);
      if (!frameBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('QA frame evidence is not a PNG: ' + sourceFrame);
      const frameFile = path.join(qaFramesDirectory, 'frame-' + String(index + 1).padStart(3, '0') + '.png');
      await writeFile(frameFile, frameBytes);
      evidenceFiles.push(frameFile);
    }
  }
  const softwareVersions = {
    node: process.version,
    hyperframes: renderManifest?.hyperframesVersion || null,
    ffmpeg: await runMediaCommand('ffmpeg', ['-version'], { signal }).then(result => result.stdout.split(/\r?\n/)[0]).catch(() => null),
    ffprobe: await runMediaCommand('ffprobe', ['-version'], { signal }).then(result => result.stdout.split(/\r?\n/)[0]).catch(() => null)
  };
  const softwareEvidencePath = await saveEvidence('software-versions.json', softwareVersions);
  const rightsCleared = assetManifest.every(asset => ['cleared', 'user-owned'].includes(asset.rightsStatus) || asset.kind === 'generated');
  const assetsPackaged = assetManifest.every(asset => asset.included);
  const canonicalIrSha256 = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const renderSourceMatches = renderManifest?.projectIrSha256 === canonicalIrSha256;
  const mediaAnalysisPassed = variants.every(variant => variant.mediaAnalysis?.passed === true);
  const productionAccepted = renderManifest?.productionReady === true && renderManifest?.verified === true && renderSourceMatches && rightsCleared && assetsPackaged && mediaAnalysisPassed;
  const receipt = {
    schemaVersion: '1.0', projectId: project.project.id, projectRevision: project.project.revision || 1,
    createdAt: new Date().toISOString(),
    status: productionAccepted ? 'accepted' : 'packaged-awaiting-production-evidence',
    acceptance: { passed: productionAccepted, reason: productionAccepted ? null : !renderManifest?.productionReady ? 'A verified production-ready render manifest is required for acceptance.' : !renderSourceMatches ? 'Render evidence does not match the packaged Canonical Video IR.' : !mediaAnalysisPassed ? 'A delivery variant failed final media analysis.' : !rightsCleared ? 'Asset rights must be cleared or user-owned before acceptance.' : !assetsPackaged ? 'Every project asset must be included in the package or generated locally.' : 'Render evidence is incomplete.' },
    variants, thumbnail,
    captions: captionFiles, sourceProject: { path: projectCopy, sha256: hashFile(sourceProjectBytes), canonicalIrSha256 },
    portableProject: { path: portableProjectPath, sha256: hashFile(portableProjectBytes) },
    assetManifest: manifestPath, provenance: project.provenance || { sources: [], software: [], decisions: [] },
    evidence: { renderManifest: renderEvidencePath, qaReport: qaEvidencePath, editorialAssembly: editorialEvidencePath, operationHistory: operationHistoryPath, softwareVersions: softwareEvidencePath, qaFrames: frameEvidence.length ? path.relative(packageRoot, qaFramesDirectory).split(path.sep).join('/') : null },
    renderManifest: renderManifest || null, qaReport: renderManifest?.qa || project.qa || null,
    limitations: assetManifest.filter(asset => asset.included === false).map(asset => ({ assetId: asset.id, reason: asset.unresolvedReason || 'Referenced asset could not be packaged.' }))
  };
  const humanReport = [
    '# Delivery report', '',
    `- Project: ${project.project.name} (${project.project.id}), revision ${project.project.revision || 1}`,
    `- Status: ${receipt.status}`,
    `- Acceptance: ${receipt.acceptance.passed ? 'passed' : 'pending'}`,
    `- Canonical IR SHA-256: ${canonicalIrSha256}`,
    `- Variants: ${variants.length}`,
    `- Referenced assets packaged: ${assetManifest.filter(asset => asset.included).length}/${assetManifest.length}`,
    `- Captions: ${captionFiles.length ? captionFiles.map(file => path.basename(file)).join(', ') : 'none'}`,
    '', 'See `delivery-receipt.json`, `integrity-manifest.json`, and the evidence files for detailed verification.'
  ].join('\n') + '\n';
  const reportPath = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'DELIVERY-REPORT.md'));
  await writeFile(reportPath, humanReport);
  const integrityFiles = [...variants.map(variant => variant.output), thumbnail, ...captionFiles, ...assetManifest.filter(asset => asset.included && asset.packagePath).map(asset => path.join(packageRoot, asset.packagePath)), projectCopy, portableProjectPath, manifestPath, ...evidenceFiles, reportPath];
  const integrity = { schemaVersion: '1.0', projectId: project.project.id, files: [] };
  for (const file of integrityFiles) {
    const bytes = await readFile(file);
    integrity.files.push({ path: path.relative(packageRoot, file).split(path.sep).join('/'), sha256: hashFile(bytes), byteSize: bytes.length });
  }
  const integrityPath = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'integrity-manifest.json'));
  const integrityBytes = Buffer.from(JSON.stringify(integrity, null, 2) + '\n');
  await writeFile(integrityPath, integrityBytes);
  receipt.integrityManifest = { path: integrityPath, sha256: hashFile(integrityBytes), fileCount: integrity.files.length };
  receipt.packageIntegrityVerification = await verifyDeliveryPackage(packageRoot);
  if (!receipt.packageIntegrityVerification.passed) throw new Error('Delivery package failed integrity verification: ' + JSON.stringify(receipt.packageIntegrityVerification.failures));
  receipt.deliveryReport = reportPath;
  const receiptPath = await assertNoSymlinkPath(packageRoot, path.join(packageRoot, 'delivery-receipt.json'));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return { ...receipt, receiptPath };
}

export async function verifyDeliveryPackage(packageRoot) {
  const root = await realpath(path.resolve(packageRoot));
  const manifestPath = path.join(root, 'integrity-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const failures = [];
  for (const file of manifest.files || []) {
    if (!safeRelativeAssetUri(file.path)) { failures.push({ path: file.path, reason: 'unsafe-path' }); continue; }
    try {
      const target = path.resolve(root, file.path);
      if (!contained(root, target)) throw new Error('path escapes package');
      const resolved = await realpath(target);
      if (!contained(root, resolved)) throw new Error('symlink escapes package');
      const bytes = await readFile(resolved), actual = hashFile(bytes);
      if (actual !== file.sha256 || bytes.length !== file.byteSize) failures.push({ path: file.path, reason: 'integrity-mismatch', expectedSha256: file.sha256, actualSha256: actual });
    } catch (error) { failures.push({ path: file.path, reason: error.message }); }
  }
  return { passed: failures.length === 0 && Array.isArray(manifest.files), checked: manifest.files?.length || 0, failures, manifestPath };
}

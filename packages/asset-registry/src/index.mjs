import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
  '.psd': 'image/vnd.adobe.photoshop', '.ai': 'application/postscript', '.pdf': 'application/pdf',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.blend': 'application/x-blender', '.obj': 'model/obj', '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.abc': 'application/octet-stream'
};
const EXT_KIND = {
  video: new Set(['.mp4','.mov','.m4v','.mkv','.webm','.avi']),
  audio: new Set(['.mp3','.wav','.aif','.aiff','.flac','.m4a']),
  image: new Set(['.png','.jpg','.jpeg','.webp','.gif','.tif','.tiff','.svg','.psd','.ai']),
  font: new Set(['.otf','.ttf','.woff','.woff2']),
  '3d': new Set(['.blend','.obj','.fbx','.glb','.gltf','.abc']),
  document: new Set(['.pdf'])
};
const hashFile = filePath => new Promise((resolve, reject) => {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', chunk => digest.update(chunk));
  stream.once('error', reject);
  stream.once('end', () => resolve(digest.digest('hex')));
});
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function classify(ext) {
  for (const [kind, extensions] of Object.entries(EXT_KIND)) if (extensions.has(ext)) return kind;
  return 'other';
}
async function walk(directory, root, output, { recursive, includeHidden, maxFiles }) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a,b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (recursive) await walk(full, root, output, { recursive, includeHidden, maxFiles });
      continue;
    }
    if (!info.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!MIME[ext]) continue;
    if (output.length >= maxFiles) throw new Error('Asset scan exceeded maxFiles=' + maxFiles + '; narrow the directory or raise the limit.');
    output.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

export async function scanAssetDirectory(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Asset root must be an existing, non-symlink directory.');
  const maxFiles = options.maxFiles ?? 10000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer.');
  const relativePaths = [];
  await walk(root, root, relativePaths, {
    recursive: options.recursive !== false,
    includeHidden: options.includeHidden === true,
    maxFiles
  });
  const assets = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(root, relativePath);
    if (!inside(root, absolutePath)) throw new Error('Asset path escapes scan root: ' + relativePath);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const digest = await hashFile(absolutePath);
    const ext = path.extname(relativePath).toLowerCase();
    const metadata = options.metadataByPath?.[relativePath] || {};
    const assetId = 'asset-' + createHash('sha256').update(relativePath + '\\0' + digest).digest('hex').slice(0, 20);
    const approvedRights = metadata.rightsApproval?.approved === true &&
      (!metadata.rightsApproval.expiresAt || Date.parse(metadata.rightsApproval.expiresAt) > Date.now()) &&
      typeof metadata.rightsApproval.actor === 'string' && metadata.rightsApproval.actor.trim() &&
      typeof metadata.rightsApproval.license === 'string' && metadata.rightsApproval.license.trim() &&
      typeof metadata.rightsApproval.usageScope === 'string' && metadata.rightsApproval.usageScope.trim();
    assets.push({
      id: assetId,
      contentId: 'content-' + digest.slice(0, 20),
      sha256: digest,
      relativePath,
      fileName: path.basename(relativePath),
      extension: ext,
      mimeType: MIME[ext],
      kind: classify(ext),
      byteSize: info.size,
      modifiedAt: info.mtime.toISOString(),
      metadata: {
        title: metadata.title || path.basename(relativePath, ext),
        creator: metadata.creator || null,
        source: metadata.source || null,
        description: metadata.description || null,
        tags: Array.isArray(metadata.tags) ? [...new Set(metadata.tags.filter(x => typeof x === 'string'))] : [],
        license: metadata.license || null,
        attribution: metadata.attribution || null,
        rightsStatus: approvedRights ? 'approved' : 'needs-review',
        rightsApproval: approvedRights ? structuredClone(metadata.rightsApproval) : null
      }
    });
  }
  const byHash = new Map();
  for (const asset of assets) byHash.set(asset.sha256, [...(byHash.get(asset.sha256) || []), asset.relativePath]);
  const duplicates = [...byHash.entries()].filter(([,paths]) => paths.length > 1).map(([sha256,paths]) => ({ sha256, paths }));
  return {
    registryVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    rootPath: root,
    assetCount: assets.length,
    assets,
    duplicates,
    summary: {
      byKind: Object.fromEntries([...new Set(assets.map(x => x.kind))].sort().map(kind => [kind, assets.filter(x => x.kind === kind).length])),
      needsRightsReview: assets.filter(x => x.metadata.rightsStatus !== 'approved').length,
      duplicateGroups: duplicates.length
    }
  };
}

export async function verifyAssetRegistry(registry, options = {}) {
  if (!registry || registry.registryVersion !== '1.0.0' || !Array.isArray(registry.assets) || typeof registry.rootPath !== 'string') {
    throw new Error('Invalid asset registry: expected registryVersion 1.0.0, rootPath and assets[].');
  }
  const root = path.resolve(options.rootPath || registry.rootPath);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Verification root must be an existing, non-symlink directory.');
  const results = [];
  for (const asset of registry.assets) {
    const absolutePath = path.resolve(root, asset.relativePath);
    if (!inside(root, absolutePath)) {
      results.push({ id: asset.id, relativePath: asset.relativePath, valid: false, reason: 'PATH_OUTSIDE_ROOT' });
      continue;
    }
    try {
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        results.push({ id: asset.id, relativePath: asset.relativePath, valid: false, reason: 'NOT_REGULAR_FILE' });
        continue;
      }
      const digest = await hashFile(absolutePath);
      results.push({
        id: asset.id, relativePath: asset.relativePath,
        valid: digest === asset.sha256,
        reason: digest === asset.sha256 ? null : 'CHECKSUM_MISMATCH',
        expectedSha256: asset.sha256, actualSha256: digest
      });
    } catch (error) {
      results.push({ id: asset.id, relativePath: asset.relativePath, valid: false, reason: error.code === 'ENOENT' ? 'MISSING_FILE' : 'READ_ERROR' });
    }
  }
  return { valid: results.every(x => x.valid), checkedAt: new Date().toISOString(), checkedCount: results.length, failures: results.filter(x => !x.valid), results };
}

export function approveAssetRights(registry, { assetId, actor, license, usageScope, attribution = null, expiresAt = null, note = '' } = {}) {
  if (!registry || !Array.isArray(registry.assets)) throw new Error('A valid asset registry is required.');
  for (const [field, value] of Object.entries({ assetId, actor, license, usageScope })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' is required.');
  }
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error('expiresAt must be a future date/time.');
  const index = registry.assets.findIndex(asset => asset.id === assetId);
  if (index < 0) throw new Error('Unknown asset id: ' + assetId);
  const next = structuredClone(registry);
  const asset = next.assets[index];
  asset.metadata = {
    ...asset.metadata,
    license,
    attribution,
    rightsStatus: 'approved',
    rightsApproval: { approved: true, actor: actor.trim(), license: license.trim(), usageScope: usageScope.trim(), attribution, expiresAt, note, approvedAt: new Date().toISOString() }
  };
  next.summary = {
    ...next.summary,
    needsRightsReview: next.assets.filter(x => x.metadata?.rightsStatus !== 'approved').length
  };
  return next;
}

export async function probeAsset(assetPath, options = {}) {
  const absolutePath = path.resolve(assetPath);
  const executable = options.ffprobePath || 'ffprobe';
  const args = ['-v','error','-show_streams','-show_format','-of','json',absolutePath];
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100_000) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('ffprobe failed (' + code + '): ' + stderr.slice(-2000)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('ffprobe returned invalid JSON.')); }
    });
  });
}

export function attachAssetRegistry(project, registry) {
  if (!project || typeof project !== 'object') throw new Error('A Canonical Video IR project is required.');
  if (!registry || registry.registryVersion !== '1.0.0' || !Array.isArray(registry.assets)) throw new Error('A valid asset registry is required.');
  const next = structuredClone(project);
  if (!Array.isArray(next.assets)) next.assets = [];
  const byId = new Map(next.assets.map(asset => [asset.id, asset]));
  for (const asset of registry.assets) {
    const normalized = {
      id: asset.id, contentId: asset.contentId || null, kind: asset.kind, uri: asset.relativePath,
      mimeType: asset.mimeType, sha256: asset.sha256, byteSize: asset.byteSize,
      metadata: structuredClone(asset.metadata)
    };
    const existing = byId.get(asset.id);
    if (existing && existing.sha256 && existing.sha256 !== asset.sha256) throw new Error('Asset id collision with different content: ' + asset.id);
    if (existing) Object.assign(existing, normalized);
    else { next.assets.push(normalized); byId.set(asset.id, normalized); }
  }
  const referenced = [];
  for (const scene of next.scenes || []) for (const layer of scene.layers || []) if (layer.assetId && !byId.has(layer.assetId)) referenced.push({ sceneId: scene.id, layerId: layer.id, assetId: layer.assetId });
  return { project: next, report: { attached: registry.assets.length, totalAssets: next.assets.length, unresolvedReferences: referenced, rightsReviewRequired: registry.assets.filter(x => x.metadata?.rightsStatus !== 'approved').map(x => x.id) } };
}

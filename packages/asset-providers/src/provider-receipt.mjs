import { createHash } from 'node:crypto';
import path from 'node:path';
import { inside } from './runtime.mjs';

export const GENERATED_ASSET_TERMS = 'Locally synthesized, no third-party material';
export const GENERATED_ASSET_LICENSE = 'Generated locally by Motion Studio; no third-party material';

// Capability contracts (roadmap P3.1: image, video/stock, music, SFX, speech)
// mapped to Canonical Video IR asset kinds. Local synthesis ships in this
// package; speech lives in @motion-studio/speech-adapter and video/stock is the
// next incremental provider slot.
export const PROVIDER_CAPABILITIES = {
  sfx: 'audio',
  'music-bed': 'audio',
  speech: 'audio',
  narration: 'audio',
  image: 'image',
  video: 'video',
  stock: 'video'
};

const MIME_BY_EXTENSION = {
  '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm'
};
const RIGHTS_STATUSES = new Set(['generated', 'unknown', 'needs-review', 'approved']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireNonEmptyString(receipt, field) {
  const value = receipt[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provider receipt ' + field + ' must be a non-empty string.');
  return value.trim();
}

// Pure: no filesystem access, so containment is enforced on resolved paths only
// (symlink escapes are caught earlier by prepareWorkspaceOutput at generation
// time). Mirrors the asset-registry record shape (id, contentId, kind, uri,
// mimeType, sha256, byteSize, metadata) so attached records flow through
// validateProject and attachAssetRegistry consumers unchanged.
export function attachProviderReceipt(project, receipt) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('A Canonical Video IR project object is required.');
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('A provider receipt object is required.');
  const provider = requireNonEmptyString(receipt, 'provider');
  const kind = requireNonEmptyString(receipt, 'kind');
  const registryKind = PROVIDER_CAPABILITIES[kind];
  if (!registryKind) throw new Error('Unknown provider capability kind: ' + kind + '. Supported: ' + Object.keys(PROVIDER_CAPABILITIES).join(', ') + '.');
  const sha256 = requireNonEmptyString(receipt, 'sha256');
  if (!SHA256_PATTERN.test(sha256)) throw new Error('Provider receipt sha256 must contain 64 hexadecimal characters.');
  if (!Number.isInteger(receipt.byteSize) || receipt.byteSize <= 0) throw new Error('Provider receipt byteSize must be a positive integer.');
  if (receipt.verified !== true) throw new Error('attachProviderReceipt only accepts FFprobe-verified receipts (verified: true); unverified output must not enter the project.');
  const projectRoot = requireNonEmptyString(receipt, 'projectRoot');
  const output = requireNonEmptyString(receipt, 'output');
  const root = path.resolve(projectRoot), resolvedOutput = path.resolve(output);
  if (!inside(root, resolvedOutput)) throw new Error('Provider receipt output escapes the project workspace: ' + output);

  const rightsStatus = receipt.rightsStatus === undefined ? (provider === 'ffmpeg-lavfi' ? 'generated' : 'unknown') : receipt.rightsStatus;
  if (!RIGHTS_STATUSES.has(rightsStatus)) throw new Error('Provider receipt rightsStatus must be one of: ' + [...RIGHTS_STATUSES].join(', ') + '.');
  // Roadmap P3.1: unlicensed or unknown-rights assets are non-final by
  // default — only 'generated' (local synthesis) and explicitly 'approved'
  // records may reach final delivery.
  const approvedForFinalUse = rightsStatus === 'generated' || rightsStatus === 'approved';
  if (rightsStatus === 'approved') {
    const approval = receipt.approval;
    if (!approval || typeof approval !== 'object') throw new Error('An approved receipt requires an approval object (actor, license, usageScope).');
    for (const field of ['actor', 'license', 'usageScope']) {
      if (typeof approval[field] !== 'string' || !approval[field].trim()) throw new Error('approval.' + field + ' must be a non-empty string.');
    }
  }
  const approvalRecord = rightsStatus === 'approved'
    ? { approved: true, actor: receipt.approval.actor.trim(), license: receipt.approval.license.trim(), usageScope: receipt.approval.usageScope.trim(), approvedAt: typeof receipt.approval.approvedAt === 'string' ? receipt.approval.approvedAt : new Date().toISOString() }
    : null;

  const uri = path.relative(root, resolvedOutput).split(path.sep).join('/');
  const mimeType = MIME_BY_EXTENSION[path.extname(uri).toLowerCase()] || 'application/octet-stream';
  const model = typeof receipt.model === 'string' && receipt.model.trim() ? receipt.model.trim() : null;
  const tags = ['provider-generated', kind, ...(typeof receipt.variant === 'string' && receipt.variant.trim() ? [receipt.variant.trim()] : [])];
  const title = typeof receipt.title === 'string' && receipt.title.trim()
    ? receipt.title.trim()
    : (receipt.variant ? receipt.kind + ' ' + receipt.variant : receipt.kind) + ' (' + provider + ')';

  const record = {
    id: 'asset-' + createHash('sha256').update(kind + '\0' + sha256).digest('hex').slice(0, 20),
    contentId: 'content-' + sha256.slice(0, 20),
    kind: registryKind,
    uri,
    mimeType,
    sha256,
    byteSize: receipt.byteSize,
    metadata: {
      title,
      creator: typeof receipt.creator === 'string' && receipt.creator.trim() ? receipt.creator.trim() : null,
      source: model ? provider + '/' + model : provider,
      description: typeof receipt.description === 'string' && receipt.description.trim() ? receipt.description.trim() : null,
      tags,
      license: typeof receipt.license === 'string' && receipt.license.trim() ? receipt.license.trim() : (approvedForFinalUse && rightsStatus === 'generated' ? GENERATED_ASSET_LICENSE : null),
      attribution: typeof receipt.attribution === 'string' && receipt.attribution.trim() ? receipt.attribution.trim() : null,
      rightsStatus,
      rightsApproval: approvalRecord,
      approvedForFinalUse,
      terms: typeof receipt.terms === 'string' && receipt.terms.trim() ? receipt.terms.trim() : null,
      prompt: typeof receipt.prompt === 'string' && receipt.prompt.trim() ? receipt.prompt.trim() : null,
      params: receipt.params && typeof receipt.params === 'object' ? structuredClone(receipt.params) : null,
      verified: true,
      generatedAt: typeof receipt.generatedAt === 'string' ? receipt.generatedAt : null
    }
  };

  const next = structuredClone(project);
  if (!Array.isArray(next.assets)) next.assets = [];
  const existingIndex = next.assets.findIndex(asset => asset.id === record.id);
  if (existingIndex >= 0) {
    const existing = next.assets[existingIndex];
    if (existing.sha256 && existing.sha256 !== record.sha256) throw new Error('Asset id collision with different content: ' + record.id);
    next.assets[existingIndex] = record;
  } else {
    next.assets.push(record);
  }

  const report = {
    attached: 1,
    totalAssets: next.assets.length,
    rightsReviewRequired: next.assets.filter(asset => asset.metadata?.rightsStatus === 'unknown' || asset.metadata?.rightsStatus === 'needs-review').map(asset => asset.id),
    nonFinalAssetIds: next.assets.filter(asset => asset.metadata?.approvedForFinalUse !== true).map(asset => asset.id)
  };
  return { project: next, report };
}

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// P4.1 versioned reusable systems: brand systems, templates and motion
// components live in a registry file with explicit version, approval,
// compatibility and rollback metadata. Production use requires an approved
// version whose declared compatibility covers the running Motion Studio
// version; rollback restores the previously approved version. The registry
// file is the source of truth — writes are atomic (temp + rename).

const STATUSES = new Set(['draft', 'approved', 'retired']);
const SCHEMA_VERSION = 1;

function registryIssue(code, message) {
  return { code, message };
}

function atomicWrite(file, text) {
  // Caller wraps in try; the temp name is unique per call.
  const temp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  return writeFile(temp, text, 'utf8').then(() => rename(temp, file));
}

function semverMajor(version) {
  const match = String(version || '').match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

// compatibility: {minVersion?: '1.2.0', maxMajor?: 2} — the running Motion
// Studio version must be >= minVersion and (when maxMajor is set) must not
// cross a declared major boundary.
function compatibilitySatisfied(compatibility, runningVersion) {
  if (!compatibility || typeof compatibility !== 'object') return true;
  const running = String(runningVersion || '').split('.').map(Number);
  const compareParts = version => String(version || '').split('.').map(Number);
  if (compatibility.minVersion) {
    const min = compareParts(compatibility.minVersion);
    for (let index = 0; index < 3; index += 1) {
      const have = running[index] || 0, need = min[index] || 0;
      if (have > need) break;
      if (have < need) return false;
    }
  }
  if (Number.isInteger(compatibility.maxMajor) && semverMajor(runningVersion) > compatibility.maxMajor) return false;
  return true;
}

async function readRegistry(registryPath) {
  let raw = null;
  try { raw = await readFile(registryPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw === null) return { schemaVersion: SCHEMA_VERSION, templates: {}, history: [] };
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.templates !== 'object') {
    throw new Error('Template registry is not a valid registry file (expected schemaVersion ' + SCHEMA_VERSION + '): ' + registryPath);
  }
  return parsed;
}

function validateEntry(entry) {
  const issues = [];
  if (!entry || typeof entry !== 'object') return [registryIssue('TEMPLATE_NOT_OBJECT', 'A template entry must be an object.')];
  if (typeof entry.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name)) issues.push(registryIssue('TEMPLATE_NAME_INVALID', 'Template name must be 1-80 characters of letters, numbers, underscores or hyphens.'));
  if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version)) issues.push(registryIssue('TEMPLATE_VERSION_INVALID', 'Template version must be semantic (major.minor.patch).'));
  if (!entry.template || typeof entry.template !== 'object') issues.push(registryIssue('TEMPLATE_BODY_REQUIRED', 'The template body (the reusable IR fragment or component) is required.'));
  if (entry.compatibility !== undefined && (typeof entry.compatibility !== 'object' || Array.isArray(entry.compatibility))) issues.push(registryIssue('COMPATIBILITY_INVALID', 'compatibility must be an object like {minVersion, maxMajor}.'));
  if (issues.length) return issues;
  return [];
}

export async function registerTemplate({ registryPath, template, author, approved = false, runningVersion = null, clock = () => new Date() } = {}) {
  const issues = validateEntry(template);
  if (issues.length) return { ok: false, issues };
  if (typeof author !== 'string' || !author.trim()) return { ok: false, issues: [registryIssue('AUTHOR_REQUIRED', 'Registering a template requires an author attribution.')] };
  const registry = await readRegistry(registryPath);
  const name = template.name;
  const prior = registry.templates[name];
  const entry = {
    name,
    version: template.version,
    author: author.trim(),
    status: approved ? 'approved' : 'draft',
    compatibility: template.compatibility ?? null,
    template: template.template,
    registeredAt: clock().toISOString(),
    priorApprovedVersion: prior?.status === 'approved' ? prior.version : null,
    compatibilityNote: null
  };
  if (approved && !compatibilitySatisfied(entry.compatibility, runningVersion)) {
    entry.status = 'draft';
    entry.compatibilityNote = 'Compatibility does not cover the running Motion Studio version (' + runningVersion + '); the template stays draft until compatibility is updated or the runtime is upgraded.';
  }
  registry.templates[name] = entry;
  registry.history.push({ at: entry.registeredAt, action: approved ? 'register-approved' : 'register-draft', name, version: entry.version, author: entry.author, priorApprovedVersion: entry.priorApprovedVersion ?? null });
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { ok: true, issues: [], entry, compatibilityNote: entry.compatibilityNote ?? null };
}

export async function getTemplate({ registryPath, name, version = null, runningVersion = null }) {
  const registry = await readRegistry(registryPath);
  const entry = registry.templates[name];
  if (!entry || (version && entry.version !== version)) return { found: false, usableInProduction: false };
  const usableInProduction = entry.status === 'approved' && compatibilitySatisfied(entry.compatibility, runningVersion);
  return {
    found: true,
    usableInProduction,
    reason: usableInProduction ? null : entry.status !== 'approved' ? 'Template version ' + entry.version + ' is ' + entry.status + ', not approved for production use.' : 'Template compatibility does not cover the running Motion Studio version (' + runningVersion + ').',
    entry: { name: entry.name, version: entry.version, status: entry.status, author: entry.author, compatibility: entry.compatibility, template: entry.template, registeredAt: entry.registeredAt }
  };
}

export async function listTemplates({ registryPath, status = null } = {}) {
  const registry = await readRegistry(registryPath);
  return Object.values(registry.templates)
    .filter(entry => !status || entry.status === status)
    .map(entry => ({ name: entry.name, version: entry.version, status: entry.status, author: entry.author, registeredAt: entry.registeredAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function approveTemplate({ registryPath, name, actor, runningVersion = null, clock = () => new Date() } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) return { ok: false, issues: [registryIssue('ACTOR_REQUIRED', 'Approval requires an identified actor.')] };
  const registry = await readRegistry(registryPath);
  const entry = registry.templates[name];
  if (!entry) return { ok: false, issues: [registryIssue('TEMPLATE_NOT_FOUND', 'No template named ' + name + ' in the registry.')] };
  if (!compatibilitySatisfied(entry.compatibility, runningVersion)) return { ok: false, issues: [registryIssue('COMPATIBILITY_UNSATISFIED', 'Template compatibility does not cover the running Motion Studio version (' + runningVersion + ').')] };
  const previous = entry.status === 'approved' ? entry.version : entry.priorApprovedVersion;
  entry.status = 'approved';
  entry.approvedBy = actor.trim();
  entry.approvedAt = clock().toISOString();
  entry.priorApprovedVersion = previous ?? null;
  registry.templates[name] = entry;
  registry.history.push({ at: entry.approvedAt, action: 'approve', name, version: entry.version, author: entry.approvedBy, priorApprovedVersion: entry.priorApprovedVersion });
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { ok: true, entry };
}

// Rollback restores the previously approved version. If none exists the
// rollback is refused rather than leaving the template retired-and-empty.
export async function rollbackTemplate({ registryPath, name, actor, clock = () => new Date() } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) return { ok: false, issues: [registryIssue('ACTOR_REQUIRED', 'Rollback requires an identified actor.')] };
  const registry = await readRegistry(registryPath);
  const entry = registry.templates[name];
  if (!entry) return { ok: false, issues: [registryIssue('TEMPLATE_NOT_FOUND', 'No template named ' + name + ' in the registry.')] };
  const previous = entry.priorApprovedVersion;
  if (!previous) return { ok: false, issues: [registryIssue('ROLLBACK_UNAVAILABLE', 'Template ' + name + ' has no previously approved version to roll back to.')] };
  const priorHistory = [...registry.history].reverse().find(event => event.name === name && event.version === previous && (event.action === 'register-approved' || event.action === 'approve'));
  if (!priorHistory?.template && !entry.template) return { ok: false, issues: [registryIssue('ROLLBACK_BODY_MISSING', 'The prior approved version ' + previous + ' has no recoverable template body.')] };
  const rolledBack = {
    ...entry,
    version: previous,
    status: 'approved',
    approvedBy: actor.trim(),
    approvedAt: clock().toISOString(),
    rolledBackFrom: entry.version,
    compatibilityNote: null
  };
  registry.templates[name] = rolledBack;
  registry.history.push({ at: rolledBack.approvedAt, action: 'rollback', name, from: entry.version, to: previous, author: rolledBack.approvedBy });
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { ok: true, entry: rolledBack };
}

export async function retireTemplate({ registryPath, name, actor, clock = () => new Date() } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) return { ok: false, issues: [registryIssue('ACTOR_REQUIRED', 'Retiring a template requires an identified actor.')] };
  const registry = await readRegistry(registryPath);
  const entry = registry.templates[name];
  if (!entry) return { ok: false, issues: [registryIssue('TEMPLATE_NOT_FOUND', 'No template named ' + name + ' in the registry.')] };
  entry.status = 'retired';
  entry.retiredBy = actor.trim();
  entry.retiredAt = clock().toISOString();
  registry.templates[name] = entry;
  registry.history.push({ at: entry.retiredAt, action: 'retire', name, version: entry.version, author: entry.retiredBy });
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { ok: true, entry };
}

export async function registryHistory(registryPath, { name = null } = {}) {
  const registry = await readRegistry(registryPath);
  return registry.history.filter(event => !name || event.name === name);
}

export { compatibilitySatisfied as isCompatibilitySatisfied };

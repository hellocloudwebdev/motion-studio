import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAdobeApplications, detectCraftApplications } from './software-detect.mjs';

// P4.2 host portability: emit the machine-readable compatibility matrix for
// the CURRENT host — which engines, craft tools and Adobe integrations are
// present and verified, per the supported platform matrix. Engine probes
// inherit the calling shell's PATH (documented behavior: a matrix rendered
// from an environment without the tool paths shows them unavailable). CI
// renders a runner-shaped matrix; developer hosts render their own.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

function probe(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return { available: false, version: null };
  const line = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
  return { available: true, version: line };
}

function craftEntry(app) {
  const candidates = [];
  const override = app === 'filmcraft' ? process.env.FILMCRAFT_CLI : process.env.EFFECTCRAFT_CLI;
  if (override?.trim()) candidates.push(override.trim());
  candidates.push(app + '-cli.exe');
  let found = candidates.find(candidate => existsSync(candidate)) || null;
  if (!found) {
    try {
      for (const entry of readdirSync('C:\\Users', { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('$') || entry.name === 'Public' || entry.name === 'Default') continue;
        const candidate = path.join('C:\\Users', entry.name, app, app + '-cli.exe');
        if (existsSync(candidate)) { found = candidate; break; }
      }
    } catch { /* users root unreadable */ }
  }
  return { id: app, available: Boolean(found), path: found, version: found ? probe(found).version : null, mcp: found ? (app === 'filmcraft' ? 'filmcraft-cli -- mcp' : 'effectcraft-cli mcp') : null };
}

const craft = detectCraftApplications();
const matrix = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
  motionStudio: { version: VERSION ?? null },
  engines: {
    hyperframes: probe('node', [path.join(ROOT, 'node_modules', 'hyperframes', 'dist', 'index.js'), '--version']),
    ffmpeg: probe('ffmpeg'), ffprobe: probe('ffprobe'), blender: probe('blender'),
    effectcraft: { id: 'effectcraft', available: craft.effectcraft.installed, path: craft.effectcraft.path, version: craft.effectcraft.version, mcp: craft.effectcraft.mcpArgs?.join(' ') ?? null },
    filmcraft: { id: 'filmcraft', available: craft.filmcraft.installed, path: craft.filmcraft.path, version: craft.filmcraft.version, mcp: craft.filmcraft.mcpArgs?.join(' ') ?? null }
  },
  licensedAdobe: {
    supported: detectAdobeApplications().supported,
    afterEffects: detectAdobeApplications().afterEffects,
    premierePro: detectAdobeApplications().premierePro,
    note: 'Licensed optional stack; Motion Studio never installs or activates Adobe products.'
  },
  npmWorkspaces: {
    craftMcpClient: existsSync(path.join(ROOT, 'packages', 'craft-mcp-client')),
    adobeMcpClient: existsSync(path.join(ROOT, 'packages', 'adobe-mcp-client')),
    effectcraftAdapter: existsSync(path.join(ROOT, 'packages', 'effectcraft-adapter')),
    editorialInterchange: existsSync(path.join(ROOT, 'packages', 'editorial-interchange'))
  }
};
console.log(JSON.stringify(matrix, null, 2) + '\n');

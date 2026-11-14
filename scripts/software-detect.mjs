import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { craftCommandCandidates } from '../packages/craft-mcp-client/src/index.mjs';

// Craft-tool detection (architecture pivot 2026-11-14: FilmCraft replaces
// Premiere Pro/Media Encoder as the editorial engine, EffectCraft replaces
// After Effects as the specialist compositing/VFX engine). Both are
// open-source Storytold tools shipping CLI binaries on every platform, so
// detection probes the CLI candidates (env override → PATH → install roots)
// and reads versions from the CLIs themselves.

function readCliVersion(command, platform) {
  if (!command) return null;
  try {
    const out = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, shell: false });
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {}
  return null;
}

export function detectCraftApplications({
  platform = process.platform,
  env = process.env,
  home = null,
  exists = existsSync,
  versionOf = readCliVersion
} = {}) {
  const detect = app => {
    const candidates = craftCommandCandidates({ app, env, platform, home });
    const found = candidates.find(candidate => exists(candidate)) || null;
    return {
      installed: Boolean(found),
      version: found ? versionOf(found, platform) : null,
      path: found,
      mcpArgs: app === 'filmcraft' ? ['--', 'mcp'] : ['mcp']
    };
  };
  const effectcraft = detect('effectcraft');
  const filmcraft = detect('filmcraft');
  const supported = true;
  return {
    supported,
    effectcraft,
    filmcraft,
    userActionsRequired: [
      !effectcraft.installed && 'install EffectCraft (https://github.com/storytold/effectcraft — releases or getartcraft.com) for specialist compositing and VFX',
      !filmcraft.installed && 'install FilmCraft (https://github.com/storytold/filmcraft — releases or getartcraft.com) for editorial assembly and export'
    ].filter(Boolean),
    note: (!effectcraft.installed || !filmcraft.installed)
      ? 'The craft tools are free and open source (MIT / Apache-2.0); Motion Studio drives them headless through their MCP-capable CLIs.'
      : null
  };
}

// Retired with the Adobe pivot; kept one release as an explicit refusal so
// stale callers fail loudly instead of silently misdetecting.
export function detectAdobeApplications() {
  throw new Error('detectAdobeApplications was retired: Motion Studio now targets FilmCraft and EffectCraft (see detectCraftApplications).');
}

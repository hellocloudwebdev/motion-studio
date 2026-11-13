#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAdobeApplications } from './software-detect.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const checks = [];
function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore', shell: false }).status === 0;
}
function commandVersion(name, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', shell: false });
  const output = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
  checks.push({ name, available: result.status === 0, version: output });
}
async function packageVersion(name) {
  try {
    const json = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    return { installed: true, version: json.version };
  } catch { return { installed: false, version: null }; }
}
commandVersion('Node.js', process.execPath, ['--version']);
checks.push({ name: 'npm', available: commandExists('npm'), version: null });
commandVersion('FFmpeg', 'ffmpeg', ['-version']);
commandVersion('FFprobe', 'ffprobe', ['-version']);
commandVersion('Blender', 'blender', ['--version']);

const hyperframes = await packageVersion('hyperframes');
const afterEffectsMcp = await packageVersion('@kumoproductions/mcp-aftereffects');
const premiereMcp = await packageVersion('premiere-pro-mcp');
const software = detectAdobeApplications();

// P4.3 additive checks. Credential checks report PRESENCE ONLY — key values
// are never read into or printed by this output.
async function findBrowserExecutable(directory, depth = 4) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && /\.(exe|app|bin)$/i.test(entry.name)) return full;
    if (entry.isDirectory() && depth > 0) {
      const found = await findBrowserExecutable(full, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
const envLocalPath = path.join(root, '.env.local');
const envLocalText = await readFile(envLocalPath, 'utf8').catch(() => null);
const envLocalKeys = new Set();
for (const line of (envLocalText || '').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  // Only the key name is kept; the value is never stored or printed.
  if (match && /\S/.test(line.slice(match[0].length))) envLocalKeys.add(match[1]);
}
function credentialPresence(name) {
  if (typeof process.env[name] === 'string' && process.env[name].trim()) return { present: true, source: 'environment' };
  if (envLocalKeys.has(name)) return { present: true, source: '.env.local' };
  return { present: false, source: null };
}
const browserCandidates = [];
for (const name of ['HYPERFRAMES_BROWSER_PATH', 'PRODUCER_HEADLESS_SHELL_PATH']) {
  if (typeof process.env[name] === 'string' && process.env[name].trim()) browserCandidates.push({ source: 'env:' + name, path: path.resolve(process.env[name].trim()) });
}
browserCandidates.push(
  { source: 'node_modules/hyperframes/browser', path: path.join(root, 'node_modules', 'hyperframes', 'browser') },
  { source: 'node_modules/hyperframes/.browser', path: path.join(root, 'node_modules', 'hyperframes', '.browser') },
  { source: '~/.cache/hyperframes/chrome', path: path.join(os.homedir(), '.cache', 'hyperframes', 'chrome') },
  { source: '~/.cache/puppeteer', path: path.join(os.homedir(), '.cache', 'puppeteer') }
);
let hyperframesBrowser = { prepared: false, source: null, path: null };
for (const candidate of browserCandidates) {
  const info = await stat(candidate.path).catch(() => null);
  const executable = info?.isFile() ? candidate.path : info ? await findBrowserExecutable(candidate.path) : null;
  if (executable) { hyperframesBrowser = { prepared: true, source: candidate.source, path: executable }; break; }
}
const benchmarkResultsPath = path.join(root, 'work', 'benchmark-results.json');
const benchmarkResultsPresent = await access(benchmarkResultsPath).then(() => true, () => false);
const result = {
  product: 'Motion Studio',
  version: (await readFile(path.join(root, 'VERSION'), 'utf8')).trim(),
  platform: process.platform,
  architecture: process.arch,
  runtime: { node: process.version, minimum: '24.0.0', compatible: nodeMajor >= 24 },
  checks,
  npmPackages: { hyperframes, afterEffectsMcp, premiereMcp },
  envLocal: { present: envLocalText !== null, path: '.env.local' },
  credentials: {
    openRouterApiKey: credentialPresence('OPENROUTER_API_KEY'),
    fishAudioApiKey: credentialPresence('FISH_AUDIO_API_KEY')
  },
  hyperframesBrowser,
  benchmarkResults: { present: benchmarkResultsPresent, path: 'work/benchmark-results.json' },
  adobe: software,
  policies: {
    afterEffectsReadonlyDefault: true,
    afterEffectsArbitraryEval: false,
    premiereUnsafeScript: false,
    maxRenderWorkersDefault: 1
  },
  missing: [
    ...(nodeMajor < 24 ? ['Node.js 24+'] : []),
    ...checks.filter(x => ['FFmpeg','FFprobe'].includes(x.name) && !x.available).map(x => x.name),
    ...(!hyperframes.installed ? ['HyperFrames npm package'] : []),
    ...(!afterEffectsMcp.installed ? ['After Effects MCP package'] : []),
    ...(!premiereMcp.installed ? ['Premiere MCP package'] : [])
  ]
};
console.log(JSON.stringify(result, null, 2));
if (nodeMajor < 24) process.exitCode = 1;

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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
const result = {
  product: 'Motion Studio',
  version: (await readFile(path.join(root, 'VERSION'), 'utf8')).trim(),
  platform: process.platform,
  architecture: process.arch,
  runtime: { node: process.version, minimum: '24.0.0', compatible: nodeMajor >= 24 },
  checks,
  npmPackages: { hyperframes, afterEffectsMcp, premiereMcp },
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

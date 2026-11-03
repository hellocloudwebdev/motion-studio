#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const checks = [['Node.js', 'node', ['--version']], ['npm', 'npm', ['--version']], ['FFmpeg', 'ffmpeg', ['-version']], ['FFprobe', 'ffprobe', ['-version']], ['HyperFrames', 'hyperframes', ['--version']], ['Blender', 'blender', ['--version']], ['Claude Code', 'claude', ['--version']], ['Codex', 'codex', ['--version']]];
const results = checks.map(([name, command, args]) => {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', shell: false });
  return { name, available: r.status === 0, version: `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0] || null };
});
console.log(JSON.stringify({ product: 'Motion Studio', version: '0.2.0', platform: process.platform, architecture: process.arch, checks: results, missing: results.filter(x => !x.available).map(x => x.name) }, null, 2));

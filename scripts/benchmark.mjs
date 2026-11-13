#!/usr/bin/env node
// P4.3 benchmark: measures EXISTING artifacts only — no new big renders.
//  - compile timing of templates/startup-ad through the HyperFrames adapter,
//  - one Blender fixture timing reference: a fresh 12-frame camera-move render
//    at the fixture's own 480x270 canvas with threads 2, into an isolated temp
//    project root (the committed fixture frames are never touched — file mtimes
//    are not trusted as evidence), skipped when Blender is missing or over budget,
//  - ffprobe timings of existing delivery masters.
// Results land in work/benchmark-results.json with machine and settings context.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileHyperFramesProject } from '../packages/hyperframes-adapter/src/index.mjs';
import { probeMedia } from '../packages/ffmpeg/src/index.mjs';
import { renderBlenderScene } from '../packages/blender-adapter/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER_BUDGET_MS = 90_000; // keeps the whole run far below the 3-minute budget

const machine = {
  cpu: os.cpus()[0]?.model?.trim() || 'unknown',
  cores: os.cpus().length,
  totalMemGB: Number((os.totalmem() / 2 ** 30).toFixed(2))
};
const settings = { renderConcurrency: 1, blenderThreads: 2, blenderBudgetMs: BLENDER_BUDGET_MS, node: process.version };
const cases = [];

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore', shell: false }).status === 0;
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else total += (await stat(file)).size;
  }
  return total;
}

function record(name, start, extra = {}) {
  cases.push({ name, seconds: Number(((performance.now() - start) / 1000).toFixed(3)), ...extra });
}

function skip(name, reason) {
  cases.push({ name, skipped: true, reason });
}

// 1. Compile timing: the checked-in startup-ad template, output to a temp dir.
{
  const name = 'compile:templates/startup-ad';
  const start = performance.now();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'motion-bench-compile-'));
  try {
    const project = JSON.parse(await readFile(path.join(root, 'templates', 'startup-ad', 'project.json'), 'utf8'));
    await compileHyperFramesProject(project, { outputDir, sourceRoot: root });
    record(name, start, { bytes: await directoryBytes(outputDir) });
  } catch (error) {
    skip(name, 'compile failed: ' + error.message.slice(0, 200));
  } finally { await rm(outputDir, { recursive: true, force: true }); }
}

// 2. Blender fixture reference: re-render ONE 12-frame fixture scene at 480x270,
//    threads 2, into an isolated temp project root so the committed fixture
//    frames stay untouched.
{
  const name = 'blender:camera-move-12f@480x270:threads2';
  const start = performance.now();
  if (!commandExists('blender')) {
    skip(name, 'Blender not found on PATH');
  } else {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-bench-blender-'));
    try {
      const project = JSON.parse(await readFile(path.join(root, 'projects', 'blender-contract-fixtures', 'project.json'), 'utf8'));
      const scene = project.scenes.find(entry => entry.id === 'camera-move');
      if (!scene) throw new Error('camera-move fixture scene missing');
      const receipt = await renderBlenderScene(project, scene, { projectRoot: outputRoot, threads: 2, signal: AbortSignal.timeout(BLENDER_BUDGET_MS) });
      record(name, start, { bytes: (await directoryBytes(receipt.framesDirectory)) });
    } catch (error) {
      const timedOut = /aborted|timeout/i.test(error.message);
      skip(name, timedOut ? 'over ' + BLENDER_BUDGET_MS / 1000 + 's budget' : 'render failed: ' + error.message.slice(0, 160));
    } finally { await rm(outputRoot, { recursive: true, force: true }); }
  }
}

// 3. Probe timings of existing delivery masters (deterministic: sorted, first 4).
{
  const deliverables = [];
  for (const entry of (await readdir(path.join(root, 'projects'), { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, 'projects', entry.name, 'deliverables');
    for (const file of (await readdir(dir).catch(() => [])).filter(name => name.toLowerCase().endsWith('.mp4')).sort()) {
      deliverables.push(path.join(dir, file));
    }
  }
  for (const file of deliverables.slice(0, 4)) {
    const name = 'probe:' + path.relative(root, file).replaceAll('\\', '/');
    const start = performance.now();
    try {
      await probeMedia(file);
      record(name, start, { bytes: (await stat(file)).size });
    } catch (error) {
      skip(name, 'probe failed: ' + error.message.slice(0, 160));
    }
  }
}

const nameWidth = Math.max(...cases.map(item => item.name.length)) + 2;
console.log('Motion Studio benchmark (P4.3) — ' + machine.cpu + ', ' + machine.cores + ' cores, ' + machine.totalMemGB + ' GB RAM, ' + process.platform + ', Node ' + process.version);
console.log('settings: renderConcurrency ' + settings.renderConcurrency + ', blenderThreads ' + settings.blenderThreads + ', blender budget ' + BLENDER_BUDGET_MS / 1000 + 's\n');
for (const item of cases) {
  if (item.skipped) console.log(item.name.padEnd(nameWidth) + ' skipped — ' + item.reason);
  else console.log(item.name.padEnd(nameWidth) + String(item.seconds).padStart(8) + 's' + (item.bytes !== undefined ? String(item.bytes).padStart(14) + ' B' : ''));
}

const results = {
  timestamp: new Date().toISOString(),
  machine,
  settings,
  cases,
  totalSeconds: Number((cases.reduce((sum, item) => sum + (item.seconds || 0), 0)).toFixed(3))
};
await writeFile(path.join(root, 'work', 'benchmark-results.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');
console.log('\nwork/benchmark-results.json written (' + cases.length + ' cases, measured total ' + results.totalSeconds + 's)');

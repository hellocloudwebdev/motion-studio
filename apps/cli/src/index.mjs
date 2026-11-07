#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { compileHyperFramesProject } from '../../../packages/hyperframes-adapter/src/index.mjs';
import { renderHyperFramesProject } from '../../../packages/render-manager/src/index.mjs';

const [command, file, ...args] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function flags() { return new Set(args.filter(x => x.startsWith('--'))); }
async function load(pathName) { return JSON.parse(await readFile(pathName, 'utf8')); }
function paths(project, sourceFile) {
  const projectRoot = path.join(process.cwd(), 'projects', project.project.id);
  return { sourceRoot: path.dirname(path.resolve(sourceFile)), projectRoot, engineRoot: path.join(projectRoot, 'engines', 'hyperframes'), outputRoot: path.join(projectRoot, 'renders') };
}

if (['validate', 'route', 'qa', 'graph', 'compile', 'render'].includes(command)) {
  if (!file) throw new Error('Usage: motion-studio ' + command + ' <project.json> [--output <path>] [--quality draft|standard|high]');
  const project = await load(file);
  const validation = validateProject(project);
  if (command === 'validate') { print(validation); if (!validation.valid) process.exitCode = 1; }
  else if (command === 'route') {
    const availableEngines = args.filter(x => !x.startsWith('--'));
    const routing = routeScenes(project, { availableEngines: availableEngines.length ? availableEngines : undefined });
    print(routing);
  } else if (command === 'qa') {
    const routing = routeScenes(project);
    print({ validation, routing, qa: runProjectQA(project, routing) });
  } else if (command === 'graph') {
    const routing = routeScenes(project);
    const graph = buildExecutionGraph(routing);
    print({ routing, graph, graphValidation: validateExecutionGraph(graph) });
  } else if (command === 'compile' || command === 'render') {
    if (!validation.valid) { print(validation); process.exitCode = 1; }
    else {
      const target = paths(project, file);
      const outputDir = option('--output', target.engineRoot);
      if (command === 'compile') {
        const result = await compileHyperFramesProject(project, { outputDir, sourceRoot: target.sourceRoot });
        print({ outputDir: result.outputDir, rootHtml: path.join(result.outputDir, 'index.html'), manifest: result.manifest, warnings: result.warnings });
      } else {
        const quality = option('--quality', 'draft');
        const result = await renderHyperFramesProject(project, { projectRoot: target.projectRoot, engineRoot: option('--engine-dir', target.engineRoot), outputRoot: option('--render-dir', target.outputRoot), installRoot: process.cwd(), sourceRoot: target.sourceRoot, quality, workers: Number(option('--workers', '1')) });
        print(result);
        if (!result.productionReady) process.exitCode = 2;
      }
    }
  }
} else if (command === 'type-scale') {
  const width = Number(option('--width', '1920')), height = Number(option('--height', '1080'));
  print(calculateTypeScale({ width, height }));
} else if (command === 'doctor') {
  const { spawnSync } = await import('node:child_process');
  const checks = [['Node.js', process.execPath, ['--version']], ['npm', 'npm', ['--version']], ['FFmpeg', 'ffmpeg', ['-version']], ['FFprobe', 'ffprobe', ['-version']], ['HyperFrames', process.execPath, [path.resolve('node_modules/hyperframes/dist/index.js'), '--version']], ['Blender', 'blender', ['--version']]];
  const results = checks.map(([name, executable, cmdArgs]) => {
    const result = spawnSync(executable, cmdArgs, { encoding: 'utf8', stdio: 'pipe', shell: false });
    return { name, available: result.status === 0, version: (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null };
  });
  print({ nodeMajor: Number(process.versions.node.split('.')[0]), minimumNodeMajor: 24, checks: results, adobeMcpPackages: ['@kumoproductions/mcp-aftereffects', 'premiere-pro-mcp'], note: 'Run scripts/doctor.mjs for installed Adobe application and connector state.' });
  if (Number(process.versions.node.split('.')[0]) < 24) process.exitCode = 1;
} else {
  console.log('Motion Studio CLI 0.5.0-alpha.2\nCommands: doctor, validate <project.json>, route <project.json>, qa <project.json>, graph <project.json>, compile <project.json>, render <project.json> [--quality draft|standard|high], type-scale --width 1920 --height 1080');
}

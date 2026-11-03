#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';

const [command, file, ...rest] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));
async function load(path) { return JSON.parse(await readFile(path, 'utf8')); }
if (command === 'validate' || command === 'route' || command === 'qa' || command === 'graph') {
  if (!file) throw new Error(`Usage: motion-studio ${command} <project.json>`);
  const project = await load(file);
  const validation = validateProject(project);
  if (command === 'validate') { print(validation); if (!validation.valid) process.exitCode = 1; }
  else {
    const routing = routeScenes(project, { availableEngines: rest.length ? rest : undefined });
    if (command === 'route') print(routing);
    if (command === 'qa') print({ validation, routing, qa: runProjectQA(project, routing) });
    if (command === 'graph') { const graph = buildExecutionGraph(routing); print({ routing, graph, graphValidation: validateExecutionGraph(graph) }); }
  }
} else if (command === 'type-scale') {
  const [width = '1920', height = '1080'] = rest; print(calculateTypeScale({ width: Number(width), height: Number(height) }));
} else {
  console.log('Motion Studio CLI 0.2.0\nCommands: validate <project.json>, route <project.json>, qa <project.json>, graph <project.json>, type-scale [width height]');
}

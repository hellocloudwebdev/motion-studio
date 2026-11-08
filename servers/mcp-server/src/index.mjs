import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { renderHyperFramesProject } from '../../../packages/render-manager/src/index.mjs';
import { buildDeliveryPackage } from '../../../packages/delivery-manager/src/index.mjs';
import { renderBlenderScene } from '../../../packages/blender-adapter/src/index.mjs';

const server = new McpServer({ name: 'motion-studio', version: '0.3.0-alpha.1' });
const projectSchema = z.record(z.string(), z.unknown());
const engineList = z.array(z.enum(['hyperframes', 'after-effects', 'blender', 'threejs', 'ffmpeg'])).optional();
function projectPaths(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('projectId must contain only letters, numbers, underscores or hyphens.');
  const root = path.resolve(process.cwd(), 'projects', id);
  const relative = path.relative(path.resolve(process.cwd(), 'projects'), root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project path escaped the projects directory.');
  return { root, source: path.join(root, 'project.json'), engine: path.join(root, 'engines', 'hyperframes'), renders: path.join(root, 'renders'), delivery: path.join(root, 'deliverables') };
}
function audioInputs(project, projectFile) {
  const assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const cues = [...(project.audio?.tracks || []), ...(project.scenes || []).flatMap(scene => scene.audioCues || [])];
  return cues.map((cue, index) => {
    const asset = assets.get(cue.assetId);
    if (!asset || asset.kind !== 'audio' || typeof asset.uri !== 'string' || /^[a-z][a-z0-9+.-]*:\/\//i.test(asset.uri)) throw new Error('Audio cue ' + index + ' must reference a local audio asset.');
    const sourceRoot = path.dirname(projectFile), file = path.resolve(sourceRoot, asset.uri), relative = path.relative(sourceRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Audio asset path escapes the project directory.');
    const start = Number(cue.offsetFrames ?? cue.startFrame ?? 0);
    return { path: file, kind: cue.kind || cue.role || 'audio', offsetSeconds: start * project.project.frameRate.denominator / project.project.frameRate.numerator, volume: cue.volume ?? 1 };
  });
}

server.tool('video.create_project_template', 'Return a starter Canonical Video IR project. Fill the creative brief and assets before production.', {
  name: z.string().min(1), width: z.number().int().positive().default(1920), height: z.number().int().positive().default(1080), fps: z.number().positive().default(30), durationSeconds: z.number().positive().default(30)
}, async ({ name, width, height, fps, durationSeconds }) => {
  const frames = Math.round(fps * durationSeconds);
  const project = { schemaVersion: '1.0.0', project: { id: 'project-' + Date.now(), name, objective: 'Define the audience outcome.', frameRate: { numerator: Math.round(fps), denominator: 1 }, canvas: { width, height, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: frames, colorSpace: 'Rec.709', revision: 1 }, creative: { concept: 'Replace with the central concept.', audience: 'Define the audience.', message: 'Define the key message.' }, assets: [], scenes: [{ id: 'scene-001', name: 'Opening', durationFrames: frames, intent: 'Introduce the message.', layers: [] }], delivery: { targets: [{ id: 'master', format: 'mp4', width, height, frameRate: { numerator: Math.round(fps), denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', colorSpace: 'Rec.709', alpha: false }] } };
  return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
});
server.tool('video.validate_project', 'Validate Canonical Video IR structure.', { project: projectSchema }, async ({ project }) => ({ content: [{ type: 'text', text: JSON.stringify(validateProject(project), null, 2) }] }));
server.tool('video.route_scenes', 'Plan engine tasks for each scene layer. This plans work; it does not render.', { project: projectSchema, availableEngines: engineList }, async ({ project, availableEngines }) => ({ content: [{ type: 'text', text: JSON.stringify(routeScenes(project, { availableEngines }), null, 2) }] }));
server.tool('video.run_project_qa', 'Run deterministic IR-level QA and attach routing defects.', { project: projectSchema, availableEngines: engineList }, async ({ project, availableEngines }) => {
  const validation = validateProject(project), routing = routeScenes(project, { availableEngines }), qa = runProjectQA(project, routing);
  return { content: [{ type: 'text', text: JSON.stringify({ validation, routing, qa }, null, 2) }] };
});
server.tool('video.build_execution_graph', 'Build the scene-render, Premiere assembly and FFmpeg delivery dependency graph.', { project: projectSchema, availableEngines: engineList }, async ({ project, availableEngines }) => {
  const routing = routeScenes(project, { availableEngines }), graph = buildExecutionGraph(routing);
  return { content: [{ type: 'text', text: JSON.stringify({ routing, graph, graphValidation: validateExecutionGraph(graph) }, null, 2) }] };
});
server.tool('video.calculate_type_scale', 'Calculate a responsive starting typography scale for a canvas.', { width: z.number().int().positive(), height: z.number().int().positive() }, async ({ width, height }) => ({ content: [{ type: 'text', text: JSON.stringify(calculateTypeScale({ width, height }), null, 2) }] }));
server.tool('video.render_project', 'Persist a validated Canonical Video IR inside the local projects directory, then compile, lint, check, render and verify it with HyperFrames. One worker is fixed by policy. The receipt may report productionReady=false when assets or other engines are missing.', { project: projectSchema, quality: z.enum(['draft', 'standard', 'high']).default('draft') }, async ({ project, quality }) => {
  const validation = validateProject(project);
  if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
  const paths = projectPaths(project.project.id);
  await mkdir(paths.root, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(paths.source, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(project)) throw new Error('A different project with this id already exists. Save a higher revision in the local project before rendering.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(paths.source, JSON.stringify(project, null, 2) + '\n', { flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST') throw error; });
  const result = await renderHyperFramesProject(project, { projectRoot: paths.root, engineRoot: paths.engine, outputRoot: paths.renders, installRoot: process.cwd(), sourceRoot: paths.root, quality, workers: 1 });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.productionReady };
});
server.tool('video.render_blender_scene', 'Render an explicitly authored Blender scene from the stored Canonical Video IR into a verified RGBA/RGB PNG frame sequence. This is a specialist scene artifact; it is not silently substituted into the HyperFrames composition.', { projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }, async ({ projectId, sceneId }) => {
  const paths = projectPaths(projectId), project = JSON.parse(await readFile(paths.source, 'utf8'));
  const validation = validateProject(project);
  if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('Unknown scene id: ' + sceneId);
  const result = await renderBlenderScene(project, scene, { projectRoot: paths.root });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});
server.tool('video.package_delivery', 'Create and independently verify delivery variants for a rendered local project. Includes captions, thumbnail, project source, asset/provenance manifest and receipt. The receipt remains awaiting evidence when the render is not production-ready.', { projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), quality: z.enum(['draft', 'standard', 'high']).default('draft') }, async ({ projectId, quality }) => {
  const paths = projectPaths(projectId), project = JSON.parse(await readFile(paths.source, 'utf8'));
  const renderFile = path.join(paths.renders, (project.project.id || projectId) + '-' + quality + '.mp4');
  let renderManifest = null;
  try { renderManifest = JSON.parse(await readFile(renderFile + '.render.json', 'utf8')); } catch {}
  const receipt = await buildDeliveryPackage({ project, projectFile: paths.source, sourceVideo: renderFile, projectRoot: paths.root, outputRoot: paths.delivery, renderManifest, audioInputs: audioInputs(project, paths.source) });
  return { content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }], isError: !receipt.acceptance.passed };
});
await server.connect(new StdioServerTransport());

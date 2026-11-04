import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import {
  previewAfterEffectsScene, applyAfterEffectsScene,
  previewPremiereAssembly, applyPremiereAssembly
} from '../../../packages/adobe-orchestrator/src/index.mjs';

const server = new McpServer({ name: 'motion-studio', version: '0.4.0-alpha.1' });
const projectSchema = z.record(z.string(), z.unknown());
const engineList = z.array(z.enum(['hyperframes', 'after-effects', 'blender', 'threejs', 'ffmpeg'])).optional();

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

server.tool('video.adobe_preview_ae_scene', 'Preview a read-only After Effects scene plan. Requires a saved, non-dirty AE project and a new backup path. Returns a one-time approval ID; no project changes are made.', {
  project: projectSchema,
  sceneId: z.string().min(1),
  backupPath: z.string().min(1)
}, async ({ project, sceneId, backupPath }) => {
  const result = await previewAfterEffectsScene({ project, sceneId, backupPath });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('video.adobe_apply_ae_scene', 'Apply a previously previewed After Effects scene plan after the user explicitly approves it. Creates a separate backup first; failures are not retried.', {
  approvalId: z.string().uuid(),
  approved: z.boolean()
}, async ({ approvalId, approved }) => {
  const result = await applyAfterEffectsScene({ approvalId, approved });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('video.adobe_preview_premiere_assembly', 'Preview importing verified scene renders into a NEW Premiere sequence. Existing timelines are not modified. Requires a saved Premiere project and new backup path.', {
  renderedScenePaths: z.array(z.string().min(1)).min(1),
  backupPath: z.string().min(1),
  sequenceName: z.string().min(1),
  backend: z.literal('cep').default('cep'),
  exportPath: z.string().min(1).optional(),
  presetPath: z.string().min(1).optional()
}, async ({ renderedScenePaths, backupPath, sequenceName, backend, exportPath, presetPath }) => {
  const result = await previewPremiereAssembly({ renderedScenePaths, backupPath, sequenceName, backend, exportPath, presetPath });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('video.adobe_apply_premiere_assembly', 'Apply a previously previewed Premiere assembly after the user explicitly approves it. Imports scene renders, creates a separate sequence, reads it back and saves; an optional export path triggers an export and file check.', {
  approvalId: z.string().uuid(),
  approved: z.boolean()
}, async ({ approvalId, approved }) => {
  const result = await applyPremiereAssembly({ approvalId, approved });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());

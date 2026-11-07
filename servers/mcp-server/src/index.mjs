import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { evaluateHostReadiness, authorizeProductionStage } from '../../../packages/orchestrator/src/host-readiness.mjs';

const server = new McpServer({ name: 'motion-studio', version: '0.6.0-alpha.1' });
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
server.tool('video.evaluate_host_readiness', 'Fail-closed preflight: require verified host evidence for every routed engine plus Premiere and FFmpeg delivery.', {
  routePlan: projectSchema, hostChecks: z.record(z.string(), z.unknown())
}, async ({ routePlan, hostChecks }) => ({ content: [{ type: 'text', text: JSON.stringify(evaluateHostReadiness(routePlan, hostChecks), null, 2) }] }));
server.tool('video.authorize_production_stage', 'Validate a time-bounded, project/run/stage-scoped approval after host readiness has passed. This records governance intent; it is not a cryptographic identity system.', {
  projectId: z.string().min(1), runId: z.string().min(1),
  stage: z.enum(['after-effects-comp', 'premiere-assembly', 'final-export']),
  hostReadiness: projectSchema, approval: z.record(z.string(), z.unknown()), now: z.number().optional()
}, async ({ projectId, runId, stage, hostReadiness, approval, now }) => ({
  content: [{ type: 'text', text: JSON.stringify(authorizeProductionStage({ projectId, runId, stage, hostReadiness, approval, now }), null, 2) }]
}));
server.tool('video.calculate_type_scale', 'Calculate a responsive starting typography scale for a canvas.', { width: z.number().int().positive(), height: z.number().int().positive() }, async ({ width, height }) => ({ content: [{ type: 'text', text: JSON.stringify(calculateTypeScale({ width, height }), null, 2) }] }));
await server.connect(new StdioServerTransport());

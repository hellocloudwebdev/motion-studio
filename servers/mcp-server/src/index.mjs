import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { evaluateHostReadiness, authorizeProductionStage } from '../../../packages/orchestrator/src/host-readiness.mjs';
import { scanAssetDirectory, verifyAssetRegistry, approveAssetRights, attachAssetRegistry, probeAsset } from '../../../packages/asset-registry/src/index.mjs';
import { generateMediaDerivatives } from '../../../packages/media-derivatives/src/index.mjs';
import { createEditorialAssembly, validateEditorialAssembly } from '../../../packages/editorial-assembly/src/index.mjs';
import { exportPremiereInterchange } from '../../../packages/premiere-interchange/src/index.mjs';
import { createProductionBrief, buildCreativeWorkflow, validateProductionBrief, validatePlanningArtifacts, compilePlanningArtifacts } from '../../../packages/production-planning/src/index.mjs';
import { createOpenRouterProvider, generateProduction } from '../../../packages/creative-pipeline/src/index.mjs';

const server = new McpServer({ name: 'motion-studio', version: '1.0.0-alpha.1' });
const projectSchema = z.record(z.string(), z.unknown());
const engineList = z.array(z.enum(['hyperframes', 'after-effects', 'blender', 'threejs', 'ffmpeg'])).optional();

server.tool('video.create_project_template', 'Return a starter Canonical Video IR project. Fill the creative brief and assets before production.', {
  name: z.string().min(1), width: z.number().int().positive().default(1920), height: z.number().int().positive().default(1080), fps: z.number().positive().default(30), durationSeconds: z.number().positive().default(30)
}, async ({ name, width, height, fps, durationSeconds }) => {
  const frames = Math.round(fps * durationSeconds);
  const project = { schemaVersion: '1.0.0', project: { id: 'project-' + Date.now(), name, objective: 'Define the audience outcome.', frameRate: { numerator: Math.round(fps), denominator: 1 }, canvas: { width, height, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: frames, colorSpace: 'Rec.709', revision: 1 }, creative: { concept: 'Replace with the central concept.', audience: 'Define the audience.', message: 'Define the key message.' }, assets: [], scenes: [{ id: 'scene-001', name: 'Opening', durationFrames: frames, intent: 'Introduce the message.', layers: [] }], delivery: { targets: [{ id: 'master', format: 'mp4', width, height, frameRate: { numerator: Math.round(fps), denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', colorSpace: 'Rec.709', alpha: false }] } };
  return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
});
server.tool('video.create_production_brief', 'Normalize and validate a natural-language video idea as a provider-neutral production brief. Unknown requirements remain explicit.', {
  intake: projectSchema
}, async ({ intake }) => {
  const brief = createProductionBrief(intake);
  return { content: [{ type: 'text', text: JSON.stringify({ brief, workflow: buildCreativeWorkflow(brief) }, null, 2) }] };
});
server.tool('video.validate_production_brief', 'Validate a previously created production brief.', {
  brief: projectSchema
}, async ({ brief }) => ({ content: [{ type: 'text', text: JSON.stringify(validateProductionBrief(brief), null, 2) }] }));
server.tool('video.plan_creative_workflow', 'Return the provider-neutral creative stage dependency graph. It does not claim that AI agents have executed.', {
  brief: projectSchema
}, async ({ brief }) => ({ content: [{ type: 'text', text: JSON.stringify(buildCreativeWorkflow(brief), null, 2) }] }));
server.tool('video.validate_planning_artifacts', 'Validate research evidence, creative direction, script, storyboard and design-system artifacts before IR compilation.', {
  planning: projectSchema
}, async ({ planning }) => ({ content: [{ type: 'text', text: JSON.stringify(validatePlanningArtifacts(planning), null, 2) }] }));
server.tool('video.compile_planning_artifacts', 'Compile approved planning artifacts into Canonical Video IR and run the project validator. Does not render or approve a production.', {
  planning: projectSchema
}, async ({ planning }) => {
  const result = compilePlanningArtifacts(planning);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});
server.tool('video.generate_production', 'Generate a research-aware creative plan and Canonical Video IR through OpenRouter. Defaults to the free-model router. Online research requires explicit per-call approval because search may incur separate charges.', {
  idea: z.string().min(1).max(5000),
  options: z.record(z.string(), z.unknown()).optional(),
  model: z.string().min(1).optional(),
  allowWebSearch: z.boolean().optional()
}, async ({ idea, options, model, allowWebSearch }) => {
  const provider = createOpenRouterProvider({ model, enableWebSearch: allowWebSearch === true });
  const result = await generateProduction(provider, { idea, options: options || {} });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
server.tool('video.scan_asset_directory', 'Scan a local media directory into a deterministic asset registry. Scanning is read-only; new assets require rights review.', {
  rootPath: z.string().min(1), recursive: z.boolean().optional(), includeHidden: z.boolean().optional(), maxFiles: z.number().int().positive().max(100000).optional()
}, async ({ rootPath, recursive, includeHidden, maxFiles }) => ({
  content: [{ type: 'text', text: JSON.stringify(await scanAssetDirectory(rootPath, { recursive, includeHidden, maxFiles }), null, 2) }]
}));
server.tool('video.verify_asset_registry', 'Verify indexed asset files still exist and match their recorded SHA-256 checksums.', {
  registry: projectSchema, rootPath: z.string().optional()
}, async ({ registry, rootPath }) => ({
  content: [{ type: 'text', text: JSON.stringify(await verifyAssetRegistry(registry, { rootPath }), null, 2) }]
}));
server.tool('video.attach_asset_registry', 'Attach an asset registry to a Canonical Video IR project as a new, non-mutating project object.', {
  project: projectSchema, registry: projectSchema
}, async ({ project, registry }) => ({
  content: [{ type: 'text', text: JSON.stringify(attachAssetRegistry(project, registry), null, 2) }]
}));
server.tool('video.approve_asset_rights', 'Record a producer-provided rights review for one asset. This is audit metadata, not legal clearance.', {
  registry: projectSchema, assetId: z.string().min(1), actor: z.string().min(1), license: z.string().min(1), usageScope: z.string().min(1), attribution: z.string().nullable().optional(), expiresAt: z.string().nullable().optional(), note: z.string().optional()
}, async ({ registry, assetId, actor, license, usageScope, attribution, expiresAt, note }) => ({
  content: [{ type: 'text', text: JSON.stringify(approveAssetRights(registry, { assetId, actor, license, usageScope, attribution, expiresAt, note }), null, 2) }]
}));
server.tool('video.probe_asset', 'Inspect local media streams and container metadata with FFprobe.', {
  filePath: z.string().min(1), timeoutMs: z.number().int().positive().max(120000).optional()
}, async ({ filePath, timeoutMs }) => ({
  content: [{ type: 'text', text: JSON.stringify(await probeAsset(filePath, { timeoutMs }), null, 2) }]
}));
server.tool('video.plan_editorial_assembly', 'Build a deterministic frame-accurate sequence manifest from Canonical Video IR. This is planning only; it does not modify Premiere or source files.', {
  project: projectSchema,
  sequenceName: z.string().min(1).optional()
}, async ({ project, sequenceName }) => ({
  content: [{ type: 'text', text: JSON.stringify(createEditorialAssembly(project, { sequenceName }), null, 2) }]
}));
server.tool('video.validate_editorial_assembly', 'Validate a previously generated editorial assembly manifest.', {
  assembly: projectSchema
}, async ({ assembly }) => ({
  content: [{ type: 'text', text: JSON.stringify(validateEditorialAssembly(assembly), null, 2) }]
}));
server.tool('video.export_premiere_interchange', 'Export a validated editorial assembly to FCPXML plus a provenance sidecar. This does not launch or modify Premiere.', {
  assembly: projectSchema,
  assetRoot: z.string().optional(),
  sequenceName: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}, async ({ assembly, ...options }) => ({
  content: [{ type: 'text', text: JSON.stringify(await exportPremiereInterchange(assembly, options), null, 2) }]
}));
server.tool('video.generate_media_derivatives', 'Generate local video proxies, thumbnails, audio waveforms or raster-image previews. Source files are never modified; outputs are hashed and are not delivery masters.', {
  sourcePath: z.string().min(1), outputDirectory: z.string().min(1),
  profile: z.enum(['all', 'proxy', 'preview']).optional(),
  thumbnailAtSeconds: z.number().min(0).max(86400).optional(),
  ffmpegPath: z.string().optional(), ffprobePath: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(), overwrite: z.boolean().optional()
}, async ({ sourcePath, outputDirectory, ...options }) => ({
  content: [{ type: 'text', text: JSON.stringify(await generateMediaDerivatives(sourcePath, outputDirectory, options), null, 2) }]
}));
server.tool('video.calculate_type_scale', 'Calculate a responsive starting typography scale for a canvas.', { width: z.number().int().positive(), height: z.number().int().positive() }, async ({ width, height }) => ({ content: [{ type: 'text', text: JSON.stringify(calculateTypeScale({ width, height }), null, 2) }] }));
await server.connect(new StdioServerTransport());

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { evaluateHostReadiness, authorizeProductionStage } from '../../../packages/orchestrator/src/host-readiness.mjs';
import { renderHyperFramesProject } from '../../../packages/render-manager/src/index.mjs';
import { buildDeliveryPackage } from '../../../packages/delivery-manager/src/index.mjs';
import { renderBlenderScene } from '../../../packages/blender-adapter/src/index.mjs';
import { renderThreeJsScene } from '../../../packages/threejs-adapter/src/index.mjs';
import { scanAssetDirectory, verifyAssetRegistry, approveAssetRights, attachAssetRegistry, probeAsset } from '../../../packages/asset-registry/src/index.mjs';
import { generateMediaDerivatives } from '../../../packages/media-derivatives/src/index.mjs';
import { createEditorialAssembly, validateEditorialAssembly } from '../../../packages/editorial-assembly/src/index.mjs';
import { exportPremiereInterchange } from '../../../packages/premiere-interchange/src/index.mjs';
import { createProductionBrief, buildCreativeWorkflow, validateProductionBrief, validatePlanningArtifacts, compilePlanningArtifacts } from '../../../packages/production-planning/src/index.mjs';

const server = new McpServer({ name: 'motion-studio', version: '1.0.0-alpha.1' });
const projectSchema = z.record(z.string(), z.unknown());
const engineList = z.array(z.enum(['hyperframes', 'after-effects', 'blender', 'threejs', 'ffmpeg'])).optional();
function projectPaths(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('projectId must contain only letters, numbers, underscores or hyphens.');
  const projectsRoot = path.resolve(process.cwd(), 'projects'), root = path.resolve(projectsRoot, id);
  const relative = path.relative(projectsRoot, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project path escaped the projects directory.');
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
  height: z.number().int().positive().optional(),
  allowUnsupportedClips: z.boolean().default(false)
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
server.tool('video.render_project', 'Persist a validated Canonical Video IR inside the local projects directory, then compile, lint, check, render and verify it with HyperFrames. One worker is fixed by policy.', {
  project: projectSchema, quality: z.enum(['draft', 'standard', 'high']).default('draft')
}, async ({ project, quality }) => {
  const validation = validateProject(project);
  if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
  const paths = projectPaths(project.project.id);
  await mkdir(paths.root, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(paths.source, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(project)) throw new Error('A different project with this id already exists. Save a higher revision before rendering.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(paths.source, JSON.stringify(project, null, 2) + '\n', { flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST') throw error; });
  const result = await renderHyperFramesProject(project, { projectRoot: paths.root, engineRoot: paths.engine, outputRoot: paths.renders, installRoot: process.cwd(), sourceRoot: paths.root, quality, workers: 1 });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.verified };
});
server.tool('video.render_blender_scene', 'Render an explicitly authored Blender scene from stored Canonical Video IR into a verified frame sequence.', {
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
}, async ({ projectId, sceneId }) => {
  const paths = projectPaths(projectId), project = JSON.parse(await readFile(paths.source, 'utf8'));
  const validation = validateProject(project);
  if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('Unknown scene id: ' + sceneId);
  const result = await renderBlenderScene(project, scene, { projectRoot: paths.root });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.verified };
});
server.tool('video.render_threejs_scene', 'Render an explicitly authored Three.js scene from stored Canonical Video IR. Unsupported layer types and model assets fail closed.', {
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), quality: z.enum(['draft', 'standard', 'high']).default('draft')
}, async ({ projectId, sceneId, quality }) => {
  const paths = projectPaths(projectId), project = JSON.parse(await readFile(paths.source, 'utf8'));
  const validation = validateProject(project);
  if (!validation.valid) return { isError: true, content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }] };
  const result = await renderThreeJsScene(project, sceneId, { projectRoot: paths.root, outputRoot: paths.renders, installRoot: process.cwd(), quality, timeoutMs: 600000 });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.verified };
});
server.tool('video.package_delivery', 'Create and independently verify delivery variants for a rendered local project.', {
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), quality: z.enum(['draft', 'standard', 'high']).default('draft')
}, async ({ projectId, quality }) => {
  const paths = projectPaths(projectId), project = JSON.parse(await readFile(paths.source, 'utf8'));
  const renderFile = path.join(paths.renders, (project.project.id || projectId) + '-' + quality + '.mp4');
  let renderManifest = null;
  try { renderManifest = JSON.parse(await readFile(renderFile + '.render.json', 'utf8')); } catch {}
  const receipt = await buildDeliveryPackage({ project, projectFile: paths.source, sourceVideo: renderFile, projectRoot: paths.root, outputRoot: paths.delivery, renderManifest, audioInputs: audioInputs(project, paths.source) });
  return { content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }], isError: !receipt.acceptance.passed };
});
server.tool('video.calculate_type_scale', 'Calculate a responsive starting typography scale for a canvas.', { width: z.number().int().positive(), height: z.number().int().positive() }, async ({ width, height }) => ({ content: [{ type: 'text', text: JSON.stringify(calculateTypeScale({ width, height }), null, 2) }] }));
await server.connect(new StdioServerTransport());

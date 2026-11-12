#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, routeScenes, runProjectQA, calculateTypeScale, persistQaRecord } from '../../../packages/core/src/index.mjs';
import { buildExecutionGraph, validateExecutionGraph } from '../../../packages/orchestrator/src/index.mjs';
import { evaluateHostReadiness } from '../../../packages/orchestrator/src/host-readiness.mjs';
import { loadQualityGates } from '../../../packages/orchestrator/src/quality-gates.mjs';
import { compileHyperFramesProject } from '../../../packages/hyperframes-adapter/src/index.mjs';
import { renderHyperFramesProject } from '../../../packages/render-manager/src/index.mjs';
import { renderMixedProject } from '../../../packages/render-manager/src/mixed-render.mjs';
import { runRepairLoop } from '../../../packages/repair-executor/src/index.mjs';
import { scanAssetDirectory, verifyAssetRegistry, approveAssetRights, attachAssetRegistry, probeAsset } from '../../../packages/asset-registry/src/index.mjs';
import { generateMediaDerivatives } from '../../../packages/media-derivatives/src/index.mjs';
import { createEditorialAssembly, validateEditorialAssembly } from '../../../packages/editorial-assembly/src/index.mjs';
import { exportPremiereInterchange } from '../../../packages/premiere-interchange/src/index.mjs';
import { buildDeliveryPackage } from '../../../packages/delivery-manager/src/index.mjs';
import { audioInputsFromProject } from '../../../packages/delivery-manager/src/audio-inputs.mjs';
import { createOpenRouterProvider, generateProduction } from '../../../packages/creative-pipeline/src/index.mjs';
import { renderThreeJsScene } from '../../../packages/threejs-adapter/src/index.mjs';
import { generateSpeech, narrationSegmentsFromProject, resolveSpeechCommand } from '../../../packages/speech-adapter/src/index.mjs';
import { generateFishAudioSpeech, resolveFishAudioOptions } from '../../../packages/speech-adapter/src/fish-audio.mjs';

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

if (command === 'assets') {
  const subcommand = file;
  if (subcommand === 'scan') {
    const root = args.find(x => !x.startsWith('--'));
    if (!root) throw new Error('Usage: motion-studio assets scan <directory> --output <registry.json> [--previous <registry.json>]');
    const previousFile = option('--previous', '');
    const previous = previousFile ? await load(previousFile) : null;
    const metadataByPath = previous ? Object.fromEntries((previous.assets || []).map(asset => [asset.relativePath, asset.metadata || {}])) : undefined;
    const registry = await scanAssetDirectory(root, { recursive: !flags().has('--no-recursive'), includeHidden: flags().has('--include-hidden'), maxFiles: Number(option('--max-files', '10000')), metadataByPath });
    const output = path.resolve(option('--output', path.join(root, 'asset-registry.json')));
    await writeFile(output, JSON.stringify(registry, null, 2) + '\n');
    print({ output, assetCount: registry.assetCount, summary: registry.summary, duplicates: registry.duplicates });
  } else if (subcommand === 'verify') {
    const registryFile = args.find(x => !x.startsWith('--'));
    if (!registryFile) throw new Error('Usage: motion-studio assets verify <registry.json> [--root <directory>]');
    const registry = await load(registryFile);
    const result = await verifyAssetRegistry(registry, { rootPath: option('--root', undefined) });
    const report = option('--report', '');
    if (report) await writeFile(path.resolve(report), JSON.stringify(result, null, 2) + '\n');
    print(result);
    if (!result.valid) process.exitCode = 4;
  } else if (subcommand === 'approve-rights') {
    const registryFile = args.find(x => !x.startsWith('--'));
    if (!registryFile) throw new Error('Usage: motion-studio assets approve-rights <registry.json> --asset-id <id> --actor <name> --license <license> --usage <scope> [--attribution <text>]');
    const registry = await load(registryFile);
    const updated = approveAssetRights(registry, { assetId: option('--asset-id', ''), actor: option('--actor', ''), license: option('--license', ''), usageScope: option('--usage', ''), attribution: option('--attribution', null), expiresAt: option('--expires-at', null), note: option('--note', '') });
    const output = path.resolve(option('--output', registryFile));
    await writeFile(output, JSON.stringify(updated, null, 2) + '\n');
    print({ updated: true, assetId: option('--asset-id', ''), output, needsRightsReview: updated.summary.needsRightsReview });
  } else if (subcommand === 'probe') {
    const assetFile = args.find(x => !x.startsWith('--'));
    if (!assetFile) throw new Error('Usage: motion-studio assets probe <media-file> [--ffprobe <path>]');
    const report = await probeAsset(assetFile, { ffprobePath: option('--ffprobe', undefined), timeoutMs: Number(option('--timeout-ms', '15000')) });
    print(report);
  } else if (subcommand === 'attach') {
    const projectFile = args.find(x => !x.startsWith('--'));
    const registryFile = option('--registry', '');
    if (!projectFile || !registryFile) throw new Error('Usage: motion-studio assets attach <project.json> --registry <registry.json> [--output <project-with-assets.json>]');
    const project = await load(projectFile), registry = await load(registryFile);
    const result = attachAssetRegistry(project, registry);
    const output = path.resolve(option('--output', 'project-with-assets.json'));
    await writeFile(output, JSON.stringify(result.project, null, 2) + '\n');
    print({ output, report: result.report });
  } else throw new Error('Unknown assets command. Use scan, verify, probe, approve-rights or attach.');
} else if (command === 'editorial' && file === 'plan') {
  const projectFile = args.find(x => !x.startsWith('--'));
  if (!projectFile) throw new Error('Usage: motion-studio editorial plan <project.json> --output <assembly.json>');
  const project = await load(projectFile);
  const assembly = createEditorialAssembly(project, { sequenceName: option('--sequence-name', undefined) });
  const output = option('--output', '');
  if (output) await writeFile(path.resolve(output), JSON.stringify(assembly, null, 2) + '\n');
  print(assembly);
  if (!assembly.summary.valid) process.exitCode = 2;
} else if (command === 'editorial' && file === 'validate') {
  const assemblyFile = args.find(x => !x.startsWith('--'));
  if (!assemblyFile) throw new Error('Usage: motion-studio editorial validate <assembly.json>');
  const result = validateEditorialAssembly(await load(assemblyFile));
  print(result);
  if (!result.valid) process.exitCode = 2;
} else if (command === 'premiere' && file === 'export') {
  const assemblyFile = args.find(x => !x.startsWith('--'));
  if (!assemblyFile) throw new Error('Usage: motion-studio premiere export <assembly.json> --output <sequence.fcpxml> [--asset-root <directory>] [--manifest <handoff.json>] [--allow-unsupported]');
  const assembly = await load(assemblyFile);
  const result = await exportPremiereInterchange(assembly, {
    assetRoot: option('--asset-root', undefined),
    sequenceName: option('--sequence-name', undefined),
    width: Number(option('--width', '1920')),
    height: Number(option('--height', '1080')),
    allowUnsupportedClips: args.includes('--allow-unsupported')
  });
  if (!result.valid) { print(result); process.exitCode = 2; }
  else {
    const output = option('--output', 'sequence.fcpxml');
    await writeFile(path.resolve(output), result.xml, 'utf8');
    const manifestPath = option('--manifest', 'premiere-handoff.json');
    await writeFile(path.resolve(manifestPath), JSON.stringify(result.manifest, null, 2) + '\n', 'utf8');
    print({ valid: true, output: path.resolve(output), manifest: path.resolve(manifestPath), warnings: result.issues });
  }
} else if (command === 'media' && file === 'derive') {
  const source = args.find(x => !x.startsWith('--'));
  const outputDir = option('--output-dir', 'media-derived');
  if (!source) throw new Error('Usage: motion-studio media derive <media-file> --output-dir <directory> [--profile all|proxy|preview] [--overwrite]');
  const result = await generateMediaDerivatives(source, outputDir, {
    profile: option('--profile', 'all'),
    thumbnailAtSeconds: Number(option('--at-seconds', '1')),
    ffmpegPath: option('--ffmpeg', undefined), ffprobePath: option('--ffprobe', undefined),
    timeoutMs: Number(option('--timeout-ms', '120000')), overwrite: flags().has('--overwrite')
  });
  const manifestPath = option('--manifest', '');
  if (manifestPath) await writeFile(path.resolve(manifestPath), JSON.stringify(result, null, 2) + '\n');
  print(result);
} else if (command === 'render-threejs') {
  const sceneId = args.find(value => !value.startsWith('--'));
  if (!file || !sceneId) throw new Error('Usage: motion-studio render-threejs <project.json> <scene-id> [--quality draft|standard|high] [--project-root <workspace-directory>]');
  const project = await load(file);
  const projectRoot = path.resolve(option('--project-root', path.dirname(path.resolve(file))));
  const relativeProjectRoot = path.relative(path.resolve(process.cwd()), projectRoot);
  if (!relativeProjectRoot || relativeProjectRoot.startsWith('..') || path.isAbsolute(relativeProjectRoot)) throw new Error('--project-root must be a child directory of the current workspace.');
  const receipt = await renderThreeJsScene(project, sceneId, { projectRoot, installRoot: process.cwd(), quality: option('--quality', 'draft'), timeoutMs: Number(option('--timeout-ms', '600000')) });
  print(receipt);
  if (!receipt.verified) process.exitCode = 2;
} else if (command === 'narration-generate') {
  if (!file) throw new Error('Usage: motion-studio narration-generate <project.json> [--project-root <projects/project-id>] [--speech-provider local|fish-audio] [--speech-model <fish-audio-model-id>] [--speech-voice <fish-audio-voice-id>] [--speech-speed <0.5-2>]');
  const speechProvider = option('--speech-provider', 'local');
  if (speechProvider !== 'local' && speechProvider !== 'fish-audio') throw new Error('--speech-provider must be "local" or "fish-audio".');
  const speechModel = option('--speech-model', undefined);
  if (speechModel !== undefined && speechProvider !== 'fish-audio') throw new Error('--speech-model only applies when --speech-provider is fish-audio.');
  const speechVoice = option('--speech-voice', undefined);
  const speechSpeed = option('--speech-speed', undefined);
  const speechSpeedNumber = speechSpeed === undefined ? undefined : Number(speechSpeed);
  if ((speechVoice !== undefined || speechSpeedNumber !== undefined) && speechProvider !== 'fish-audio') throw new Error('--speech-voice and --speech-speed only apply when --speech-provider is fish-audio.');
  if (speechSpeed !== undefined && (!Number.isFinite(speechSpeedNumber) || speechSpeedNumber < 0.5 || speechSpeedNumber > 2)) throw new Error('--speech-speed must be a number between 0.5 and 2.');
  const fishOptions = speechProvider === 'fish-audio' ? resolveFishAudioOptions(process.env, { model: speechModel, voiceId: speechVoice }) : null;
  const sourceProject = await load(file);
  const projectId = sourceProject.project?.id;
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) throw new Error('Project id must contain only letters, numbers, underscores or hyphens.');
  const projectsRoot = path.resolve(process.cwd(), 'projects');
  const projectRoot = path.resolve(option('--project-root', path.join(projectsRoot, projectId)));
  const relative = path.relative(projectsRoot, projectRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('--project-root must remain inside the current workspace projects directory.');
  await mkdir(projectRoot, { recursive: true });
  const realProjectsRoot = await realpath(projectsRoot);
  const realProjectRoot = await realpath(projectRoot);
  const realRelative = path.relative(realProjectsRoot, realProjectRoot);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Resolved project root escaped the workspace projects directory.');
  const projectFile = path.join(realProjectRoot, 'project.json');
  try {
    const existing = await load(projectFile);
    if (JSON.stringify(existing) !== JSON.stringify(sourceProject)) throw new Error('A different project already exists in this project workspace.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(projectFile, JSON.stringify(sourceProject, null, 2) + '\n', { flag: 'wx' }); }
  const project = await load(projectFile);
  const narrationSegments = narrationSegmentsFromProject(project);
  const speechInfo = speechProvider === 'fish-audio' ? { provider: 'fish-audio', extension: '.wav' } : resolveSpeechCommand();
  const assetIds = [], captions = [], cues = [], receipts = [];
  const secondsPerFrame = project.project.frameRate.denominator / project.project.frameRate.numerator;
  let cursorFrame = 0;
  for (const [index, segment] of narrationSegments.entries()) {
    const scene = project.scenes?.[index];
    let sceneStart = scene?.startFrame;
    if (!Number.isInteger(sceneStart)) {
      sceneStart = 0;
      for (const previous of project.scenes?.slice(0, index) || []) sceneStart = Math.max(sceneStart, (previous.startFrame ?? sceneStart) + (previous.durationFrames || 0));
    }
    const leadInFrames = Number.isInteger(segment.leadInFrames) ? segment.leadInFrames : 0;
    const startFrame = Math.max(cursorFrame, Math.max(0, sceneStart - leadInFrames));
    const assetId = 'generated-narration-' + String(index + 1).padStart(3, '0');
    const audioFile = path.join(realProjectRoot, 'assets', 'narration', 'segment-' + String(index + 1).padStart(3, '0') + speechInfo.extension);
    const receipt = speechProvider === 'fish-audio'
      ? await generateFishAudioSpeech(segment.text, { outputPath: audioFile, projectRoot: realProjectRoot, timeoutMs: Number(option('--timeout-ms', '120000')), apiKey: fishOptions.apiKey, model: fishOptions.model, voiceId: fishOptions.voiceId, speed: speechSpeedNumber })
      : await generateSpeech(segment.text, { outputPath: audioFile, projectRoot: realProjectRoot, timeoutMs: Number(option('--timeout-ms', '120000')) });
    const durationFrames = Math.max(1, Math.ceil(receipt.audio.durationSeconds / secondsPerFrame));
    const endFrame = startFrame + durationFrames;
    if (endFrame > project.project.totalDurationFrames) throw new Error('Generated narration segment ' + (index + 1) + ' extends beyond the project duration; revise the script or increase the target duration before attaching audio.');
    const relativeUri = path.relative(realProjectRoot, audioFile).split(path.sep).join('/');
    const assetMetadata = { generated: true, provider: receipt.provider, ...(speechProvider === 'fish-audio' ? { model: receipt.model, voiceId: receipt.voiceId, speed: receipt.speed, providerFreeTier: true, terms: receipt.providerTerms.note } : {}), sampleRate: receipt.audio.sampleRate, channels: receipt.audio.channels, durationSeconds: receipt.audio.durationSeconds, trailingSilenceTrimmedSeconds: receipt.trailingSilenceTrimmed };
    project.assets = [...(project.assets || []).filter(item => item.id !== assetId), { id: assetId, kind: 'audio', uri: relativeUri, sha256: receipt.sha256, byteSize: receipt.byteSize, source: speechProvider === 'fish-audio' ? 'fish-audio' : 'generated-local-speech', rightsStatus: 'unknown', metadata: assetMetadata }];
    assetIds.push(assetId); receipts.push(receipt);
    cues.push({ assetId, kind: 'narration', offsetFrames: startFrame, durationFrames, volume: Number(option('--gain', '1')) });
    captions.push({ id: 'narration-caption-' + String(index + 1).padStart(3, '0'), startFrame, endFrame, text: segment.text });
    cursorFrame = endFrame;
  }
  project.audio = project.audio || {};
  const generatedIds = new Set(assetIds);
  project.audio.tracks = [...(project.audio.tracks || []).filter(cue => !generatedIds.has(cue.assetId)), ...cues];
  project.captions = [...(project.captions || []).filter(cue => !String(cue.id || '').startsWith('narration-caption-')), ...captions];
  const validation = validateProject(project);
  if (!validation.valid) throw new Error('Generated narration project failed Canonical Video IR validation: ' + JSON.stringify(validation.issues));
  await writeFile(projectFile, JSON.stringify(project, null, 2) + '\n');
  print({ provider: speechInfo.provider, segments: receipts, assetIds, captionCount: captions.length, projectFile, projectId, projectRevision: project.project.revision || 1, validation, rightsReviewRequired: true });
} else if (command === 'plan') {
  const optionValues = new Set(['--duration', '--audience', '--purpose', '--language', '--platform', '--aspect-ratio', '--model', '--output', '--references-json', '--assets-json', '--brand-json']);
  const ideaParts = [];
  let skipValue = false;
  for (const value of [file, ...args]) {
    if (!value) continue;
    if (skipValue) { skipValue = false; continue; }
    if (value.startsWith('--')) { if (optionValues.has(value)) skipValue = true; continue; }
    ideaParts.push(value);
  }
  const idea = ideaParts.join(' ').trim();
  if (!idea) throw new Error('Usage: motion-studio plan "<video idea>" [--duration 45] [--audience <text>] [--purpose <text>] [--language English] [--platform youtube] [--aspect-ratio 16:9] [--output <directory>] [--allow-web-search]');
  const options = {
    durationSeconds: option('--duration', undefined) === undefined ? undefined : Number(option('--duration', undefined)),
    audience: option('--audience', undefined), purpose: option('--purpose', undefined),
    language: option('--language', undefined), platform: option('--platform', undefined), aspectRatio: option('--aspect-ratio', undefined)
  };
  const referencesFile = option('--references-json', '');
  const assetsFile = option('--assets-json', '');
  const brandFile = option('--brand-json', '');
  if (referencesFile) options.references = await load(referencesFile);
  if (assetsFile) options.suppliedAssets = await load(assetsFile);
  if (brandFile) options.brand = await load(brandFile);
  const provider = createOpenRouterProvider({ model: option('--model', process.env.MOTION_STUDIO_MODEL), enableWebSearch: flags().has('--allow-web-search') });
  const production = await generateProduction(provider, { idea, options });
  if (production.status === 'needs-input') { print(production); process.exitCode = 3; }
  else {
    const outputDir = path.resolve(option('--output', path.join(process.cwd(), 'projects', production.project.project.id)));
    await mkdir(outputDir, { recursive: true });
    const projectFile = path.join(outputDir, 'project.json'), planFile = path.join(outputDir, 'production-plan.json');
    const plan = { ...production }; delete plan.project;
    await writeFile(projectFile, JSON.stringify(production.project, null, 2) + '\n', { flag: 'wx' });
    await writeFile(planFile, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    print({ status: production.status, projectFile, planFile, validation: production.validation, acceptance: production.acceptance });
  }
} else if (command === 'qa-approve') {
  if (!file) throw new Error('Usage: motion-studio qa-approve <project-with-qa.json> --actor <name> [--note <text>] [--output <path>]');
  const project = await load(file);
  const runs = project.qa?.runs || [];
  const latest = runs.at(-1);
  if (!latest || latest.passed !== true || latest.productionReady !== true) throw new Error('Only a passing, production-ready QA run can be approved.');
  const repairPlan = (project.qa?.repairHistory || []).findLast(item => item.runId === latest.id) || { attempt: 0, status: 'no-action', actions: [] };
  const actor = option('--actor', 'producer');
  const approved = persistQaRecord(project, {
    run: { id: latest.id, renderManifest: latest.renderManifest, createdAt: latest.createdAt },
    qaResult: latest, repairPlan,
    approval: { approved: true, actor, note: option('--note', '') }
  });
  const output = path.resolve(option('--output', 'project-approved.json'));
  await writeFile(output, JSON.stringify(approved, null, 2) + '\n');
  print({ approved: true, runId: latest.id, actor, output });
} else if (['validate', 'route', 'qa', 'graph', 'preflight', 'compile', 'render', 'deliver'].includes(command)) {
  if (!file) throw new Error('Usage: motion-studio ' + command + ' <project.json> [--host-checks <host-checks.json>] [--output <path>]');
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
  } else if (command === 'preflight') {
    if (!validation.valid) { print({ validation, ready: false }); process.exitCode = 1; }
    else {
      const hostChecksFile = option('--host-checks', '');
      if (!hostChecksFile) throw new Error('preflight requires --host-checks <host-checks.json> with verified host evidence.');
      const routing = routeScenes(project);
      const readiness = evaluateHostReadiness(routing, await load(hostChecksFile));
      print({ validation, routing, readiness });
      if (!readiness.ready) process.exitCode = 3;
    }
  } else if (command === 'deliver') {
    const sourceVideo = args.find(x => !x.startsWith('--'));
    if (!sourceVideo) throw new Error('Usage: motion-studio deliver <project.json> <rendered.mp4>');
    const target = paths(project, file);
    let renderManifest = null;
    try { renderManifest = JSON.parse(await readFile(path.resolve(sourceVideo) + '.render.json', 'utf8')); } catch {}
    const assembly = createEditorialAssembly(project);
    const delivery = await buildDeliveryPackage({ project, projectFile: file, sourceVideo, projectRoot: target.projectRoot, outputRoot: option('--output', path.join(target.projectRoot, 'deliverables')), renderManifest, editorialAssembly: assembly, operationHistory: project.qa?.repairHistory || [], audioInputs: await audioInputsFromProject(project, file) });
    print(delivery);
    if (!delivery.acceptance.passed) process.exitCode = 2;
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
        // Repair-cycle budget defaults to the governed quality gates; the
        // explicit flag overrides the policy.
        const qualityGates = await loadQualityGates(path.resolve('configs/quality-gates.json'));
        const result = await renderHyperFramesProject(project, {
          projectRoot: target.projectRoot, engineRoot: option('--engine-dir', target.engineRoot),
          outputRoot: option('--render-dir', target.outputRoot), installRoot: process.cwd(),
          sourceRoot: target.sourceRoot, quality, workers: Number(option('--workers', '1')),
          repairAttempt: Number(option('--repair-attempt', '0')),
          maxRepairAttempts: Number(option('--max-repair-attempts', String(qualityGates.repair.maxCycles))),
          mediaAnalysis: {
            ocr: !flags().has('--no-ocr'), requireOcr: flags().has('--require-ocr'),
            requireContinuousAudio: flags().has('--require-continuous-audio'),
            strictFreeze: flags().has('--strict-freeze'),
            blackDurationSeconds: Number(option('--black-duration', '0.25')),
            freezeDurationSeconds: Number(option('--freeze-duration', '2')),
            silenceDurationSeconds: Number(option('--silence-duration', '2.5'))
          }
        });
        print(result);
        if (!result.productionReady) process.exitCode = 2;
      }
    }
  }
} else if (command === 'render-mixed') {
  // Mixed 2D/3D path: routes each scene to its engine (HyperFrames scoped
  // segments / Blender frame sequences), assembles in IR scene order and
  // verifies the master. Concurrency stays 1; fails closed on unsupported
  // shapes (mixed engines in one scene, non-contiguous timelines).
  if (!file) throw new Error('Usage: motion-studio render-mixed <project.json> [--quality draft] [--threads 2] [--project-root <dir>]');
  const mixedProject = await load(file);
  const mixedValidation = validateProject(mixedProject);
  if (!mixedValidation.valid) { print(mixedValidation); process.exitCode = 1; }
  else {
    const target = paths(mixedProject, file);
    const result = await renderMixedProject(mixedProject, {
      projectRoot: option('--project-root', target.projectRoot),
      outputRoot: option('--render-dir', target.outputRoot),
      quality: option('--quality', 'draft'),
      threads: Number(option('--threads', '2')),
      installRoot: process.cwd()
    });
    print(result);
    if (!result.verified || !result.productionReady) process.exitCode = 2;
  }
} else if (command === 'repair') {
  // Repair loop entry (design §4.2 step 1). No shell spawning: the executor
  // renders through render-manager's fixed-executable argv paths, workers
  // always 1 and placeholders always off.
  if (!file) throw new Error('Usage: motion-studio repair <project.json> [--max-cycles N] [--no-targeted] [--quality draft] [--dry-run] [--project-root <dir>]');
  const maxCyclesRaw = option('--max-cycles', undefined);
  const projectRootOption = option('--project-root', undefined);
  let projectRootResolved = null;
  if (projectRootOption) {
    projectRootResolved = path.resolve(projectRootOption);
    const relativeProjectRoot = path.relative(path.resolve(process.cwd()), projectRootResolved);
    if (!relativeProjectRoot || relativeProjectRoot.startsWith('..') || path.isAbsolute(relativeProjectRoot)) throw new Error('--project-root must be a child directory of the current workspace.');
  }
  const result = await runRepairLoop({
    projectFile: path.resolve(file),
    configPath: path.resolve('configs/quality-gates.json'),
    maxCyclesOverride: maxCyclesRaw === undefined ? undefined : Number(maxCyclesRaw),
    quality: option('--quality', 'draft'),
    dryRun: flags().has('--dry-run'),
    targetedRerender: flags().has('--no-targeted') ? false : undefined,
    ...(projectRootResolved ? { projectRoot: projectRootResolved } : {})
  });
  print({
    status: result.status,
    exitCode: result.exitCode,
    runId: result.run?.id ?? null,
    cycles: result.cycles,
    patch: result.patch ?? null,
    wouldEscalate: result.wouldEscalate ?? null,
    escalationReasons: result.escalationReasons ?? [],
    escalations: result.escalations.map(item => ({ jsonPath: item.jsonPath, markdownPath: item.markdownPath })),
    renderManifests: result.renderManifests.map(manifest => ({ output: manifest.output, verified: manifest.verified, productionReady: manifest.productionReady, resumed: manifest.resumed === true })),
    errors: result.errors
  });
  process.exitCode = result.exitCode;
} else if (command === 'type-scale') {
  const width = Number(option('--width', '1920')), height = Number(option('--height', '1080'));
  print(calculateTypeScale({ width, height }));
} else if (command === 'doctor') {
  const { spawnSync } = await import('node:child_process');
  const checks = [['Node.js', process.execPath, ['--version']], ['npm', 'npm', ['--version']], ['FFmpeg', 'ffmpeg', ['-version']], ['FFprobe', 'ffprobe', ['-version']], ['Tesseract OCR (optional)', 'tesseract', ['--version']], ['HyperFrames', process.execPath, [path.resolve('node_modules/hyperframes/dist/index.js'), '--version']], ['Blender', 'blender', ['--version']]];
  const results = checks.map(([name, executable, cmdArgs]) => {
    const result = spawnSync(executable, cmdArgs, { encoding: 'utf8', stdio: 'pipe', shell: false });
    return { name, available: result.status === 0, version: (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null };
  });
  print({ nodeMajor: Number(process.versions.node.split('.')[0]), minimumNodeMajor: 24, checks: results, adobeMcpPackages: ['@kumoproductions/mcp-aftereffects', 'premiere-pro-mcp'], note: 'Run scripts/doctor.mjs for installed Adobe application and connector state.' });
  if (Number(process.versions.node.split('.')[0]) < 24) process.exitCode = 1;
} else {
  console.log('Motion Studio CLI 1.0.0-alpha.1\nCommands: plan "<video idea>" [--model openrouter/free] [--allow-web-search], narration-generate <project.json> [--speech-provider local|fish-audio] [--speech-model <fish-audio-model-id>] [--speech-voice <id>] [--speech-speed <0.5-2>], render-threejs <project.json> <scene-id> [--project-root <directory>], assets scan|verify|probe|approve-rights|attach, media derive, editorial plan|validate, premiere export, doctor, validate <project.json>, route <project.json>, qa <project.json>, graph <project.json>, preflight <project.json> --host-checks <host-checks.json>, compile <project.json>, render <project.json> [--quality draft|standard|high], render-mixed <project.json> [--quality draft] [--threads 2] [--project-root <dir>], repair <project.json> [--max-cycles N] [--no-targeted] [--quality draft] [--dry-run] [--project-root <dir>], deliver <project.json> <rendered.mp4>, qa-approve <project-with-qa.json> --actor <name>, type-scale --width 1920 --height 1080');
}

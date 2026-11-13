import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderHyperFramesProject, rationalFps, safeSceneId, compilerBlockerWarnings, createMediaQaContext } from './index.mjs';
import { analyzeRenderedMedia } from './media-analysis.mjs';
import { renderBlenderScene } from '../../blender-adapter/src/index.mjs';
import { routeScenes, projectIrSha256, evaluateRenderEvidence, createRepairPlan, persistQaRecord } from '../../core/src/index.mjs';
import { assembleScenes, countVideoFrames, normalizeAssemblyAudioInputs, probeMedia, runMediaCommand } from '../../ffmpeg/src/index.mjs';

// Mixed-path v1 capability boundary (mirrors the receipt `limitations` entries):
// whole scenes render on exactly one supported engine and single-scene engine
// mixing, explicit scene start offsets are rejected instead of silently
// dropped. The assembled master stays video-only unless the caller supplies
// audioInputs, in which case cues are mixed in at assembly time (see
// mixedRenderLimitations).
const MIXED_SUPPORTED_ENGINES = new Set(['hyperframes', 'blender']);
const MIXED_LIMITATIONS = [
  { code: 'SINGLE_SCENE_MULTI_ENGINE_UNSUPPORTED', reason: 'v1 renders every scene on exactly one engine; scenes mixing HyperFrames and Blender layers are rejected before rendering instead of being silently split.' },
  { code: 'EXPLICIT_SCENE_START_OFFSETS_UNSUPPORTED', reason: 'Assembly v1 requires scenes to tile contiguously from frame 0; explicit startFrame offsets, gaps and overlaps are rejected.' },
  { code: 'ASSEMBLY_IS_VIDEO_ONLY', reason: 'Scene assembly concatenates video segments without audio; audio mixing happens at delivery through finalizeMedia.' }
];

// P3.3: supplying audioInputs supersedes ASSEMBLY_IS_VIDEO_ONLY — the mixed
// master then carries the mixed cues (aac), and the receipt says so explicitly.
export function mixedRenderLimitations(audioEnabled) {
  if (!audioEnabled) return MIXED_LIMITATIONS;
  return [
    ...MIXED_LIMITATIONS.filter(item => item.code !== 'ASSEMBLY_IS_VIDEO_ONLY'),
    { code: 'AUDIO_MIXED_AT_ASSEMBLY', reason: 'Caller-supplied audioInputs were mixed into the assembled master at assembly time (aac); assembly without audioInputs remains video-only and delivery-time finalizeMedia mixing is unchanged.' }
  ];
}

// Classify routeScenes plans into whole-scene engine buckets. Scenes whose
// tasks span multiple engines, or that route to engines outside the v1 mixed
// path (threejs, after-effects, ffmpeg-only), come back as `unsupported`.
export function classifyMixedScenes(plans) {
  const classification = { hyperframes: [], blender: [], unsupported: [] };
  for (const plan of Array.isArray(plans) ? plans : []) {
    const engines = [...new Set((plan.tasks || []).map(task => task.engine))];
    if (!engines.length) classification.unsupported.push({ sceneId: plan.sceneId, reason: 'no-engine-tasks', engines });
    else if (engines.length > 1) classification.unsupported.push({ sceneId: plan.sceneId, reason: 'multi-engine-scene', engines });
    else if (!MIXED_SUPPORTED_ENGINES.has(engines[0])) classification.unsupported.push({ sceneId: plan.sceneId, reason: 'engine-unsupported-in-v1', engines });
    else classification[engines[0]].push(plan.sceneId);
  }
  return classification;
}

// Assembly v1 requires scenes to tile contiguously: scene N starts exactly
// where scene N-1 ended, starting at frame 0. Declared startFrames equal to
// the cumulative start are accepted; gaps, overlaps and offsets are rejected.
export function validateContiguousSceneTimeline(scenes) {
  const timeline = [];
  let expectedStart = 0;
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!scene || typeof scene.id !== 'string' || !scene.id) throw new Error('Mixed assembly requires every scene to have a non-empty id.');
    if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) throw new Error('Scene ' + scene.id + ' must declare a positive integer durationFrames for assembly.');
    if (scene.startFrame !== undefined && scene.startFrame !== expectedStart) {
      throw new Error('Scene ' + scene.id + ' declares startFrame ' + scene.startFrame + ' but assembly v1 expects contiguous tiling from frame ' + expectedStart + '. Explicit startFrame offsets, gaps and overlaps are unsupported for assembly; reorder scenes or fix durationFrames in the Canonical Video IR.');
    }
    timeline.push({ sceneId: scene.id, startFrame: expectedStart, durationFrames: scene.durationFrames });
    expectedStart += scene.durationFrames;
  }
  if (!timeline.length) throw new Error('Mixed assembly requires at least one renderable scene.');
  return timeline;
}

// Blender returns a verified PNG frame sequence; this deterministic encode
// turns one scene's sequence into an MP4 segment matching the HyperFrames
// segment contract (exact rational fps, IR frame count, yuv420p, faststart).
export function buildBlenderSegmentPlan({ framesDirectory, frameCount, output, fps } = {}) {
  if (typeof framesDirectory !== 'string' || !framesDirectory.trim() || framesDirectory.includes('\0')) throw new Error('framesDirectory must be a non-empty path.');
  if (!Number.isInteger(frameCount) || frameCount <= 0) throw new Error('frameCount must be a positive integer.');
  if (typeof output !== 'string' || !output.trim() || output.includes('\0')) throw new Error('output must be a non-empty path.');
  const rate = rationalFps(fps);
  const pattern = path.join(path.resolve(framesDirectory), 'frame_%04d.png');
  const args = ['-hide_banner', '-y', '-framerate', rate.argument, '-i', pattern, '-frames:v', String(frameCount), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', rate.argument, '-movflags', '+faststart', path.resolve(output)];
  return { executable: 'ffmpeg', args, output: path.resolve(output), frameCount, fps: rate };
}

function frameRateMatches(media, fpsValue) {
  const [n, d = '1'] = String(media.frameRate).split('/');
  return Number.isFinite(Number(n) / Number(d)) && Math.abs(Number(n) / Number(d) - fpsValue) < 0.001;
}

function shiftFindingToTimeline(finding, startFrame, fpsValue) {
  const shifted = { ...finding };
  if (finding.event && Number.isFinite(Number(finding.event.start))) shifted.event = { ...finding.event, start: Number(finding.event.start) + startFrame / fpsValue, ...(finding.event.end != null ? { end: Number(finding.event.end) + startFrame / fpsValue } : {}) };
  if (Number.isFinite(Number(finding.atSeconds))) shifted.atSeconds = Number(finding.atSeconds) + startFrame / fpsValue;
  return shifted;
}

async function extractQaFrame(segmentPath, atSeconds, framePath, signal) {
  await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', atSeconds.toFixed(3), '-i', segmentPath, '-frames:v', '1', '-update', '1', framePath], { signal });
  const info = await stat(framePath);
  if (!info.isFile() || info.size === 0) throw new Error('FFmpeg could not decode a QA sample at ' + atSeconds.toFixed(3) + 's from scene segment: ' + segmentPath);
  return info;
}

export async function renderMixedProject(project, options = {}) {
  if (!project?.project || typeof project.project.id !== 'string' || !project.project.id) throw new Error('A Canonical Video IR project with project.id is required.');
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'renders'));
  const quality = options.quality || 'draft';
  if (!['draft', 'looks', 'standard', 'high', 'delivery'].includes(quality)) throw new Error('Unsupported mixed render quality: ' + quality);
  const threads = options.threads === undefined ? 2 : Number(options.threads);
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new Error('threads must be a positive integer between 1 and 64.');
  const fps = rationalFps(project.project.frameRate);
  const canvas = project.project.canvas;
  if (!Number.isInteger(canvas?.width) || canvas.width <= 0 || !Number.isInteger(canvas?.height) || canvas.height <= 0) throw new Error('Project canvas needs positive integer dimensions.');
  const onLine = options.onLine || (() => {});
  const signal = options.signal;
  // AGENTS.md: render concurrency stays at one; scene renders are sequential.
  const workers = 1;
  const renderLabel = typeof options.renderLabel === 'string' && options.renderLabel.trim() ? options.renderLabel.trim() : 'mixed';
  const throwOnQaFailure = options.throwOnQaFailure !== false;

  // P3.3 optional assembly-time audio: cues are mixed into the assembled
  // master at assembly time. Relative cue paths resolve against the project
  // root; shape validation and existence checks fail closed here — before any
  // scene renders — so a bad cue can never waste a full render pass.
  const providedAudioInputs = options.audioInputs ?? [];
  if (!Array.isArray(providedAudioInputs)) throw new Error('audioInputs must be an array of { path, offsetSeconds, durationSeconds, volume, fadeInSeconds, fadeOutSeconds, duckAgainst } audio cues.');
  for (const [index, input] of providedAudioInputs.entries()) {
    if (!input || typeof input !== 'object' || typeof input.path !== 'string' || !input.path.trim()) throw new Error('audioInputs[' + index + '] must be an object with a non-empty path.');
  }
  const audioInputs = normalizeAssemblyAudioInputs(providedAudioInputs.map(input => ({
    ...input,
    path: path.resolve(projectRoot, input.path),
    ...(input.duckAgainst === undefined ? {} : { duckAgainst: path.resolve(projectRoot, input.duckAgainst) })
  })));
  for (const cue of audioInputs) {
    try { await access(cue.path); }
    catch { throw new Error('Audio input file is missing: ' + cue.path); }
  }
  const audioEnabled = audioInputs.length > 0;

  // IR is the only source of truth: route scenes, then fail closed on anything
  // outside the v1 mixed path (mixed-engine scenes, threejs/after-effects).
  const routing = routeScenes(project, { availableEngines: [...MIXED_SUPPORTED_ENGINES] });
  const classification = classifyMixedScenes(routing.plans);
  if (classification.unsupported.length) {
    throw new Error('Mixed render v1 supports only whole-scene HyperFrames or whole-scene Blender renders. Unsupported scenes: '
      + classification.unsupported.map(item => item.sceneId + ' [' + item.reason + ': ' + item.engines.join(', ') + ']').join('; ')
      + '. Scenes mixing 2D and 3D layers in one composition cannot be composited in v1; split them into separate scenes in the Canonical Video IR.');
  }
  const timeline = validateContiguousSceneTimeline(project.scenes);
  const timelineById = new Map(timeline.map(entry => [entry.sceneId, entry]));
  const sceneCount = (project.scenes || []).length;
  if (timeline.length !== sceneCount) throw new Error('Mixed assembly requires every project scene to be renderable; ' + (sceneCount - timeline.length) + ' scene(s) lack a valid id or durationFrames.');

  await mkdir(outputRoot, { recursive: true });
  const segmentsDir = path.join(outputRoot, renderLabel, 'segments');
  await mkdir(segmentsDir, { recursive: true });
  const segmentByScene = new Map();
  const sceneReceipts = [];
  const findings = [];
  const compileWarnings = [];
  const startedAt = new Date().toISOString();

  // 1. HyperFrames-only scenes: one scoped composition render each, reusing the
  //    proven `render --composition scenes/<id>.html` path with the mixed label.
  for (const sceneId of classification.hyperframes) {
    const manifest = await renderHyperFramesProject(project, {
      projectRoot, outputRoot, quality, workers, sceneIds: [sceneId], renderLabel,
      throwOnQaFailure: false, signal, onLine,
      ...(options.sourceRoot !== undefined ? { sourceRoot: options.sourceRoot } : {}),
      ...(options.installRoot !== undefined ? { installRoot: options.installRoot } : {}),
      ...(options.mediaAnalysis !== undefined ? { mediaAnalysis: options.mediaAnalysis } : {}),
      ...(options.visualCriticProvider ? { visualCriticProvider: options.visualCriticProvider } : {}),
      repairAttempt: options.repairAttempt,
      maxRepairAttempts: options.maxRepairAttempts
    });
    const segment = (manifest.segments || [])[0];
    if (!segment) throw new Error('Scoped HyperFrames render did not return a segment for scene ' + sceneId + '.');
    const timelineEntry = timelineById.get(sceneId);
    segmentByScene.set(sceneId, segment.output);
    sceneReceipts.push({
      sceneId, engine: 'hyperframes', output: segment.output, bytes: segment.bytes,
      durationFrames: timelineEntry.durationFrames, media: segment.media,
      verified: manifest.verified === true, passed: segment.passed === true,
      findings: segment.findings || [], qa: manifest.qa || null, hyperframesVersion: manifest.hyperframesVersion || null
    });
    findings.push(...(manifest.mediaAnalysis?.findings || []));
    compileWarnings.push(...(manifest.compileWarnings || []));
  }

  // 2. Blender scenes: verified PNG frame sequence, then a deterministic MP4
  //    segment encode verified against the IR scene duration.
  const mediaAnalysisOptions = { safeAreaPercent: canvas.safeAreaPercent ?? 5, ...(options.mediaAnalysis || {}) };
  for (const sceneId of classification.blender) {
    const scene = (project.scenes || []).find(item => item.id === sceneId);
    if (!scene) throw new Error('Blender scene ' + sceneId + ' is missing from the Canonical Video IR.');
    const timelineEntry = timelineById.get(sceneId);
    const blenderReceipt = await renderBlenderScene(project, scene, { projectRoot, threads, signal, onLine });
    const segmentPath = path.join(segmentsDir, safeSceneId(sceneId) + '.mp4');
    await rm(segmentPath, { force: true });
    const encodePlan = buildBlenderSegmentPlan({ framesDirectory: blenderReceipt.framesDirectory, frameCount: blenderReceipt.frameCount, output: segmentPath, fps: project.project.frameRate });
    await runMediaCommand(encodePlan.executable, encodePlan.args, { signal });
    const segmentStat = await stat(segmentPath);
    if (!segmentStat.isFile() || segmentStat.size === 0) throw new Error('FFmpeg did not produce a non-empty MP4 segment for Blender scene ' + sceneId + ' at ' + segmentPath);
    const media = await probeMedia(segmentPath, { signal });
    const frameCount = await countVideoFrames(segmentPath, { signal });
    const expectedSeconds = timelineEntry.durationFrames / fps.value;
    const checks = {
      dimensionsMatch: media.width === canvas.width && media.height === canvas.height,
      frameRateMatch: frameRateMatches(media, fps.value),
      frameCountMatchesIr: frameCount === timelineEntry.durationFrames,
      durationWithinOneFrame: Math.abs(media.durationSeconds - expectedSeconds) <= 1 / fps.value + 0.02,
      nonEmpty: segmentStat.size > 0
    };
    if (!Object.values(checks).every(Boolean)) throw new Error('Blender scene segment failed verification for scene ' + sceneId + ': ' + JSON.stringify({ checks, media }));
    const midpoint = Math.max(0, expectedSeconds / 2 - 1 / fps.value);
    const framePath = path.join(outputRoot, 'qa-frames', 'mixed-' + safeSceneId(sceneId) + '.png');
    const frameInfo = await extractQaFrame(segmentPath, midpoint, framePath, signal);
    const frameEvidence = [{ sceneId, atSeconds: midpoint, path: framePath, bytes: frameInfo.size, decoded: frameInfo.size > 0 }];
    const analysis = await analyzeRenderedMedia({ input: segmentPath, media, frameEvidence, options: mediaAnalysisOptions, signal });
    const startSeconds = timelineEntry.startFrame / fps.value;
    const shiftedFindings = analysis.findings.map(finding => ({ ...shiftFindingToTimeline(finding, timelineEntry.startFrame, fps.value), sceneId }));
    segmentByScene.set(sceneId, segmentPath);
    sceneReceipts.push({
      sceneId, engine: 'blender', output: segmentPath, bytes: segmentStat.size,
      durationFrames: timelineEntry.durationFrames, media, frameCount,
      verified: true, passed: analysis.passed === true, findings: shiftedFindings,
      qa: null, blender: { renderer: blenderReceipt.renderer, blenderVersion: blenderReceipt.blenderVersion, threads: blenderReceipt.threads, framesDirectory: blenderReceipt.framesDirectory, frameCount: blenderReceipt.frameCount, retriedFrames: blenderReceipt.retriedFrames, frameEvidenceDigest: blenderReceipt.frameEvidenceDigest }
    });
    findings.push(...shiftedFindings);
  }

  // 3. QA frame evidence: one decoded sample per scene segment, in IR order.
  const inspectionDir = path.join(outputRoot, 'qa-frames');
  await mkdir(inspectionDir, { recursive: true });
  const frameEvidence = [];
  for (const [index, entry] of timeline.entries()) {
    const segmentPath = segmentByScene.get(entry.sceneId);
    if (!segmentPath) throw new Error('No rendered segment for scene ' + entry.sceneId + '; mixed assembly requires every scene to render exactly one segment.');
    const atSeconds = Math.max(0, entry.durationFrames / 2 / fps.value);
    const framePath = path.join(inspectionDir, 'mixed-' + String(index + 1).padStart(2, '0') + '-' + safeSceneId(entry.sceneId) + '.png');
    const frameInfo = await extractQaFrame(segmentPath, atSeconds, framePath, signal);
    frameEvidence.push({ sceneId: entry.sceneId, atSeconds: (entry.startFrame + entry.durationFrames / 2) / fps.value, path: framePath, bytes: frameInfo.size, decoded: frameInfo.size > 0 });
  }

  // 4. Assemble the master in exact IR scene order (contiguity validated above).
  const totalDurationFrames = timeline.reduce((sum, entry) => sum + entry.durationFrames, 0);
  const master = path.join(outputRoot, (project.project.id || 'motion-studio') + '-mixed-' + quality + '.mp4');
  const assembly = await assembleScenes({
    sceneFiles: timeline.map(entry => ({ path: segmentByScene.get(entry.sceneId), durationFrames: entry.durationFrames })),
    fps: project.project.frameRate, output: master,
    width: canvas.width, height: canvas.height,
    videoCodec: options.videoCodec === undefined ? 'libx264' : options.videoCodec,
    audioInputs,
    signal, timeoutMs: options.timeoutMs, onLine
  });

  const mediaAnalysis = {
    version: 1, scoped: true,
    segments: sceneReceipts.map(receipt => ({ sceneId: receipt.sceneId, engine: receipt.engine, output: receipt.output, passed: receipt.passed })),
    findings, passed: sceneReceipts.length > 0 && findings.every(finding => finding.severity !== 'critical' && finding.severity !== 'high'),
    analyzedAt: new Date().toISOString()
  };
  const checks = {
    dimensionsMatch: assembly.media.width === canvas.width && assembly.media.height === canvas.height,
    frameRateMatch: frameRateMatches(assembly.media, fps.value),
    frameCountMatchesTimeline: assembly.frameCount === totalDurationFrames,
    irSceneDurationMatchesProject: !Number.isInteger(project.project.totalDurationFrames) || totalDurationFrames === project.project.totalDurationFrames,
    scenesComplete: sceneReceipts.length === sceneCount,
    assemblyVerified: assembly.verified === true,
    scenesVerified: sceneReceipts.every(receipt => receipt.verified),
    masterAudioMixed: !audioEnabled || assembly.media.hasAudio === true,
    mediaAnalysisPassed: mediaAnalysis.passed,
    nonEmpty: assembly.bytes > 0
  };
  const verified = Object.values(checks).every(Boolean);
  const compilerBlockers = compilerBlockerWarnings(compileWarnings);
  const manifest = {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    projectIrSha256: projectIrSha256(project),
    engine: 'mixed-hyperframes-blender',
    output: master,
    bytes: assembly.bytes,
    quality,
    fps: fps.value,
    fpsRational: fps.argument,
    workers,
    threads,
    sceneTimeline: timeline,
    sceneReceipts,
    assembly,
    limitations: mixedRenderLimitations(audioEnabled),
    ...(audioEnabled ? { audio: { enabled: true, codec: assembly.media.audioCodec, inputs: audioInputs } } : {}),
    media: assembly.media,
    checks,
    frameEvidence,
    mediaAnalysis,
    compileWarnings,
    blockingWarnings: compilerBlockers,
    routingIssues: routing.issues,
    startedAt,
    completedAt: new Date().toISOString(),
    verified,
    productionReady: false
  };
  const renderManifestPath = path.join(outputRoot, path.basename(master) + '.render.json');
  const qaResult = evaluateRenderEvidence(
    { ...manifest, productionReady: verified && compilerBlockers.length === 0, blockingWarnings: compilerBlockers },
    createMediaQaContext(mediaAnalysis, project, renderManifestPath)
  );
  const repairPlan = createRepairPlan(qaResult, {
    attempt: Number.isInteger(options.repairAttempt) ? options.repairAttempt : 0,
    maxAttempts: Number.isInteger(options.maxRepairAttempts) ? options.maxRepairAttempts : 2
  });
  manifest.qa = qaResult;
  manifest.repairPlan = repairPlan;
  manifest.productionReady = qaResult.passed && verified && compilerBlockers.length === 0;
  await writeFile(renderManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'qa-report.json'), JSON.stringify(qaResult, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'repair-plan.json'), JSON.stringify(repairPlan, null, 2) + '\n');
  const qaProject = persistQaRecord(project, {
    run: { id: project.project.id + '-mixed-' + Date.now(), renderManifest: path.basename(renderManifestPath) },
    qaResult: { ...qaResult, productionReady: manifest.productionReady },
    repairPlan
  });
  await writeFile(path.join(outputRoot, 'project-with-qa.json'), JSON.stringify(qaProject, null, 2) + '\n');
  // Callers driving their own repair loop can pass throwOnQaFailure: false and
  // inspect manifest.qa / manifest.repairPlan instead of catching the throw.
  if (throwOnQaFailure && !manifest.productionReady) throw new Error('Mixed render failed deterministic QA. See QA report: ' + path.join(outputRoot, 'qa-report.json'));
  return manifest;
}

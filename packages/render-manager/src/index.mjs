import { spawn } from 'node:child_process';
import { mkdir, access, stat, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileHyperFramesProject } from '../../hyperframes-adapter/src/index.mjs';
import { parseProbeOutput } from '../../ffmpeg/src/index.mjs';
import { evaluateRenderEvidence, createRepairPlan, persistQaRecord, runVisualCritic, projectIrSha256 } from '../../core/src/index.mjs';
import { analyzeRenderedMedia } from './media-analysis.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Matches the HyperFrames adapter's safeId sanitization for scene composition
// file names (scenes/<id>.html).
const safeSceneId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'scene';

// Scoped segment paths are keyed by the adapter's sanitized scene-id form; two
// distinct scene ids that sanitize to the same segment name would overwrite each
// other's render, so scoped renders reject colliding ids outright.
export function assertScopedSceneSegmentIdsUnique(scenes) {
  const names = (Array.isArray(scenes) ? scenes : []).map(scene => safeSceneId(scene?.id));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error('Scoped rendering cannot distinguish scenes whose ids sanitize to the same segment name: ' + duplicate + '. Rename the scenes with unique [a-zA-Z0-9_-] ids.');
  return names;
}

// Absolute scene starts follow the project convention: a declared startFrame,
// otherwise the cumulative sum of previous durations.
export function computeSceneTimeline(project) {
  const timeline = [];
  let nextStart = 0;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    const durationFrames = Number(scene?.durationFrames);
    const startFrame = Number.isInteger(scene?.startFrame) && scene.startFrame >= 0 ? scene.startFrame : nextStart;
    if (!Number.isInteger(durationFrames) || durationFrames <= 0 || typeof scene?.id !== 'string' || !scene.id) continue;
    timeline.push({ sceneId: scene.id, startFrame, durationFrames });
    nextStart = Math.max(nextStart, startFrame + durationFrames);
  }
  return timeline;
}

export async function resolveHyperFramesCli(installRoot = MODULE_ROOT) {
  const packageDir = path.resolve(installRoot, 'node_modules', 'hyperframes');
  const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.hyperframes;
  if (typeof bin !== 'string' || !bin) throw new Error('Installed HyperFrames package does not declare the hyperframes CLI binary.');
  const entry = path.resolve(packageDir, bin);
  const relative = path.relative(packageDir, entry);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('HyperFrames CLI path escapes its package directory.');
  await access(entry);
  return { entry, version: packageJson.version, packageDir };
}

function run(command, args, { cwd, env = process.env, onLine = () => {}, signal, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; onLine({ stream: 'stdout', text: chunk }); });
    child.stderr.on('data', chunk => { stderr += chunk; onLine({ stream: 'stderr', text: chunk }); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(command + ' ' + args.join(' ') + ' failed with exit code ' + code + '\n' + (stderr || stdout).slice(-8000)));
    });
  });
}

function rationalFps(frameRate) {
  const numerator = Number(frameRate?.numerator);
  const denominator = Number(frameRate?.denominator);
  if (!Number.isInteger(numerator) || numerator <= 0 || !Number.isInteger(denominator) || denominator <= 0) {
    throw new Error('Canonical Video IR frameRate must be a positive integer rational.');
  }
  return {
    value: numerator / denominator,
    argument: denominator === 1 ? String(numerator) : numerator + '/' + denominator
  };
}

// Media findings keep their severity and seconds here; render QA (core) converts
// them to integer frame ranges at the manifest fps and localizes them to scenes.
export function createMediaQaContext(mediaAnalysis, project, evidencePath = null) {
  return {
    mediaFindings: Array.isArray(mediaAnalysis?.findings) ? mediaAnalysis.findings : [],
    scenes: Array.isArray(project?.scenes) ? project.scenes : [],
    evidencePath: evidencePath || null
  };
}

export async function renderHyperFramesProject(project, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const engineRoot = path.resolve(options.engineRoot || path.join(projectRoot, 'engines', 'hyperframes'));
  const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'renders'));
  const workerCount = Math.max(1, Math.min(4, Number(options.workers || 1)));
  const quality = options.quality || 'draft';
  if (!['draft', 'looks', 'standard', 'high', 'delivery'].includes(quality)) throw new Error('Unsupported HyperFrames render quality: ' + quality);
  const fps = rationalFps(project.project.frameRate);
  const onLine = options.onLine || (() => {});
  const signal = options.signal;
  const installRoot = path.resolve(options.installRoot || MODULE_ROOT);
  const cli = await resolveHyperFramesCli(installRoot);
  await mkdir(outputRoot, { recursive: true });
  const sceneIds = Array.isArray(options.sceneIds) && options.sceneIds.length ? options.sceneIds.map(id => String(id)) : null;
  if (sceneIds) {
    const known = new Set((project.scenes || []).map(scene => scene?.id));
    const unknown = sceneIds.filter(id => !known.has(id));
    if (unknown.length) throw new Error('sceneIds references scenes that do not exist in the project: ' + unknown.join(', '));
  }
  const isScopedRender = Boolean(sceneIds);
  // A targeted re-render of affected scenes must never bake placeholder media in.
  const allowMissingAssets = isScopedRender ? false : options.allowMissingAssetsAsPlaceholders !== false;
  const renderLabel = typeof options.renderLabel === 'string' && options.renderLabel.trim() ? options.renderLabel.trim() : isScopedRender ? 'targeted' : null;
  const throwOnQaFailure = options.throwOnQaFailure !== false;
  const scopedScenes = isScopedRender ? (project.scenes || []).filter(scene => sceneIds.includes(scene.id)) : (project.scenes || []);
  if (isScopedRender) assertScopedSceneSegmentIdsUnique(scopedScenes);
  const sceneTimeline = computeSceneTimeline(project);

  const compile = await compileHyperFramesProject(project, {
    outputDir: engineRoot,
    sourceRoot: options.sourceRoot || projectRoot,
    sceneIds,
    allowMissingAssetsAsPlaceholders: allowMissingAssets
  });
  const steps = [];
  const execute = async (name, args, allowFailure = false) => {
    const result = await run(process.execPath, [cli.entry, ...args], {
      cwd: engineRoot,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' },
      onLine,
      signal,
      allowFailure
    });
    steps.push({ name, args, exitCode: result.code, optional: allowFailure });
    if (result.code !== 0 && !allowFailure) throw new Error('HyperFrames ' + name + ' failed. ' + result.stderr.slice(-4000));
    return result;
  };

  await execute('doctor', ['doctor'], true);
  const lint = await execute('lint', ['lint', engineRoot, '--json']);
  const check = await execute('check', ['check', engineRoot, '--json'], true);
  const checkReportPath = path.join(outputRoot, 'hyperframes-check.json');
  let checkReport = null;
  try {
    checkReport = JSON.parse(check.stdout);
    await writeFile(checkReportPath, JSON.stringify(checkReport, null, 2) + '\n');
  } catch {
    throw new Error('HyperFrames check did not return valid JSON. Output: ' + check.stdout.slice(0, 2000));
  }
  if (check.code !== 0 || checkReport.ok === false) {
    throw new Error('HyperFrames layout/runtime QA failed before render. Evidence: ' + checkReportPath + '\n' + JSON.stringify(checkReport.layout?.findings || checkReport.findings || [], null, 2));
  }

  const fullDurationSeconds = compile.manifest.durationSeconds;
  const expectedIrDuration = isScopedRender
    ? scopedScenes.reduce((sum, scene) => sum + scene.durationFrames, 0) * project.project.frameRate.denominator / project.project.frameRate.numerator
    : Number(project.project.totalDurationFrames) * project.project.frameRate.denominator / project.project.frameRate.numerator;
  // Sample each scene at its midpoint. Avoid the nominal last frame, which may
  // fall past the last decodable frame when container durations are rounded.
  // A scoped compile places the first selected scene at scoped-timeline frame 0,
  // so segment sampling always uses cumulative starts; full renders keep the
  // project's absolute-start convention.
  const sampleEnd = Math.max(0, fullDurationSeconds - 2 / fps.value);
  let nextSceneStart = 0;
  const sceneSamples = scopedScenes.slice(0, 12).map(scene => {
    const start = isScopedRender ? nextSceneStart : (Number.isInteger(scene.startFrame) ? scene.startFrame : nextSceneStart);
    nextSceneStart = Math.max(nextSceneStart, start + scene.durationFrames);
    return Math.min(sampleEnd, (start + scene.durationFrames / 2) / fps.value);
  });
  const snapshotTimes = options.snapshotTimes || [...new Set(sceneSamples.length ? sceneSamples : [fullDurationSeconds / 2])];
  await execute('snapshot', ['snapshot', engineRoot, '--at', snapshotTimes.map(x => Number(x).toFixed(3)).join(',')]);

  const expectedWidth = Number(project.project.canvas.width);
  const expectedHeight = Number(project.project.canvas.height);
  const mediaAnalysisOptions = { safeAreaPercent: project.project.canvas.safeAreaPercent ?? 5, ...(options.mediaAnalysis || {}) };
  const inspectionDir = path.join(outputRoot, 'qa-frames');
  await mkdir(inspectionDir, { recursive: true });
  let outputFile = null, outputBytes = 0, media = null, checks = {}, frameEvidence = [], mediaAnalysis = null, segments = null;

  if (isScopedRender) {
    // Targeted render: each affected scene is rendered as its own segment via
    // the HyperFrames CLI composition flag, then inspected individually.
    const segmentsDir = path.join(outputRoot, renderLabel, 'segments');
    await mkdir(segmentsDir, { recursive: true });
    segments = [];
    const mergedFindings = [];
    for (const scene of scopedScenes) {
      const sceneId = safeSceneId(scene.id);
      const compositionPath = 'scenes/' + sceneId + '.html';
      const segmentPath = path.join(segmentsDir, sceneId + '.mp4');
      await rm(segmentPath, { force: true });
      await execute('render-scene:' + scene.id, ['render', '--composition', compositionPath, '--output', segmentPath, '--fps', fps.argument, '--quality', quality, '--workers', String(workerCount), '--low-memory-mode']);
      const segmentStat = await stat(segmentPath);
      if (!segmentStat.isFile() || segmentStat.size === 0) throw new Error('HyperFrames did not produce a non-empty MP4 segment for scene ' + scene.id + ' at ' + segmentPath);
      const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', segmentPath], { cwd: outputRoot, signal });
      const segmentMedia = parseProbeOutput(probe.stdout);
      const timelineEntry = sceneTimeline.find(item => item.sceneId === scene.id) || { startFrame: 0, durationFrames: scene.durationFrames };
      const sceneDurationSeconds = timelineEntry.durationFrames * project.project.frameRate.denominator / project.project.frameRate.numerator;
      const midpoint = Math.max(0, Math.min(sceneDurationSeconds / 2, sceneDurationSeconds - 1 / fps.value));
      const framePath = path.join(inspectionDir, 'frame-' + String(segments.length + 1).padStart(2, '0') + '.png');
      const ffmpeg = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', midpoint.toFixed(3), '-i', segmentPath, '-frames:v', '1', '-update', '1', framePath], { cwd: outputRoot, signal });
      let frameStat;
      try { frameStat = await stat(framePath); }
      catch { throw new Error('FFmpeg could not decode QA sample at ' + midpoint.toFixed(3) + 's from scene segment: ' + segmentPath); }
      frameEvidence.push({ sceneId: scene.id, atSeconds: midpoint, path: framePath, bytes: frameStat.size, decoded: frameStat.size > 0, ffmpegExitCode: ffmpeg.code });
      const analysis = await analyzeRenderedMedia({ input: segmentPath, media: segmentMedia, frameEvidence: [frameEvidence.at(-1)], options: mediaAnalysisOptions, signal });
      // Findings are shifted from scene-local time onto the project timeline so
      // render QA localizes them to the affected scenes.
      const startSeconds = timelineEntry.startFrame / fps.value;
      for (const finding of analysis.findings) {
        const shifted = { ...finding, sceneId: scene.id };
        if (finding.event && Number.isFinite(Number(finding.event.start))) shifted.event = { ...finding.event, start: Number(finding.event.start) + startSeconds, ...(finding.event.end != null ? { end: Number(finding.event.end) + startSeconds } : {}) };
        if (Number.isFinite(Number(finding.atSeconds))) shifted.atSeconds = Number(finding.atSeconds) + startSeconds;
        mergedFindings.push(shifted);
      }
      segments.push({ sceneId: scene.id, composition: compositionPath, output: segmentPath, bytes: segmentStat.size, durationSeconds: segmentMedia.durationSeconds, sceneDurationSeconds, media: segmentMedia, passed: analysis.passed, findings: analysis.findings, detectors: analysis.detectors });
    }
    const frameRateMatches = item => { const [n, d = '1'] = String(item.media.frameRate).split('/'); return Math.abs(Number(n) / Number(d) - fps.value) < 0.001; };
    checks = {
      dimensionsMatch: segments.every(item => item.media.width === expectedWidth && item.media.height === expectedHeight),
      frameRateMatch: segments.every(frameRateMatches),
      durationWithinOneFrame: segments.every(item => Math.abs(item.media.durationSeconds - item.sceneDurationSeconds) <= 1 / fps.value + 0.02),
      irSceneDurationMatchesProject: Math.abs(segments.reduce((sum, item) => sum + Number(item.media.durationSeconds || 0), 0) - expectedIrDuration) <= 0.5 / fps.value,
      hasVideo: segments.every(item => Boolean(item.media.width && item.media.height && item.media.videoCodec)),
      nonEmpty: segments.every(item => item.bytes > 0),
      segmentsComplete: segments.length === scopedScenes.length,
      hyperFramesCheckPassed: checkReport.ok !== false && Number(checkReport.errorCount || 0) === 0
    };
    mediaAnalysis = {
      version: 1,
      scoped: true,
      segments: segments.map(({ sceneId, composition, output, passed }) => ({ sceneId, composition, output, passed })),
      findings: mergedFindings,
      passed: segments.length > 0 && segments.every(item => item.passed),
      analyzedAt: new Date().toISOString()
    };
    outputFile = segmentsDir;
    outputBytes = segments.reduce((sum, item) => sum + item.bytes, 0);
  } else {
    outputFile = path.join(renderLabel ? path.join(outputRoot, renderLabel) : outputRoot, (project.project.id || 'motion-studio') + '-' + quality + '.mp4');
    if (renderLabel) await mkdir(path.dirname(outputFile), { recursive: true });
    await rm(outputFile, { force: true });
    await execute('render', ['render', '--output', outputFile, '--fps', fps.argument, '--quality', quality, '--workers', String(workerCount), '--low-memory-mode']);
    const outputStat = await stat(outputFile);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('HyperFrames did not produce a non-empty MP4 at ' + outputFile);
    outputBytes = outputStat.size;

    const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputFile], { cwd: outputRoot, signal });
    media = parseProbeOutput(probe.stdout);
    const expectedDuration = fullDurationSeconds;
    checks = {
      dimensionsMatch: media.width === expectedWidth && media.height === expectedHeight,
      frameRateMatch: (() => { const [n, d = '1'] = String(media.frameRate).split('/'); return Math.abs(Number(n) / Number(d) - fps.value) < 0.001; })(),
      durationWithinOneFrame: Math.abs(media.durationSeconds - expectedDuration) <= 1 / fps.value + 0.02,
      irSceneDurationMatchesProject: Math.abs(expectedDuration - expectedIrDuration) <= 0.5 / fps.value,
      hasVideo: Boolean(media.width && media.height && media.videoCodec),
      nonEmpty: outputBytes > 0,
      hyperFramesCheckPassed: checkReport.ok !== false && Number(checkReport.errorCount || 0) === 0
    };
    for (let i = 0; i < snapshotTimes.length; i += 1) {
      const at = Math.max(0, Math.min(expectedDuration - 1 / fps.value, Number(snapshotTimes[i])));
      const framePath = path.join(inspectionDir, 'frame-' + String(i + 1).padStart(2, '0') + '.png');
      const ffmpeg = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', outputFile, '-frames:v', '1', '-update', '1', framePath], { cwd: outputRoot, signal });
      let frameStat;
      try { frameStat = await stat(framePath); }
      catch { throw new Error('FFmpeg could not decode QA sample at ' + at.toFixed(3) + 's from rendered output: ' + outputFile); }
      frameEvidence.push({ atSeconds: at, path: framePath, bytes: frameStat.size, decoded: frameStat.size > 0, ffmpegExitCode: ffmpeg.code });
    }
    mediaAnalysis = await analyzeRenderedMedia({
      input: outputFile, media, frameEvidence,
      options: mediaAnalysisOptions,
      signal
    });
  }
  checks.mediaAnalysisPassed = mediaAnalysis.passed;
  const verified = Object.values(checks).every(Boolean) && frameEvidence.every(x => x.decoded);
  const compilerBlockers = compile.warnings.filter(x => ['ASSET_REFERENCE_MISSING', 'ASSET_FILE_MISSING', 'EXTERNAL_ASSET', 'NON_HYPERFRAMES_LAYER', 'UNSUPPORTED_LAYER_KIND'].includes(x.code));
  const mediaBlockers = mediaAnalysis.findings.filter(x => x.severity === 'critical' || x.severity === 'high').map(x => ({ code: x.code, message: x.message }));
  const blockingWarnings = [...compilerBlockers, ...mediaBlockers];
  const manifest = {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    projectIrSha256: projectIrSha256(project),
    engine: 'hyperframes',
    hyperframesVersion: cli.version,
    output: outputFile,
    bytes: outputBytes,
    quality,
    fps: fps.value,
    fpsRational: fps.argument,
    workers: workerCount,
    sceneTimeline,
    ...(renderLabel ? { renderLabel } : {}),
    ...(segments ? { scopedSceneIds: scopedScenes.map(scene => scene.id), segments } : {}),
    media,
    checks,
    hyperFramesCheck: { path: checkReportPath, issues: checkReport },
    hyperFramesLint: { output: lint.stdout, exitCode: 0 },
    frameEvidence,
    mediaAnalysis,
    compileWarnings: compile.warnings,
    blockingWarnings,
    steps,
    completedAt: new Date().toISOString(),
    verified,
    productionReady: false
  };
  const renderManifestPath = path.join(outputRoot, path.basename(outputFile) + '.render.json');
  // Media blockers stay on the manifest record; inside QA they are represented as
  // localized render-media defects instead of lossy BLOCKING_* warnings.
  const qaResult = evaluateRenderEvidence(
    { ...manifest, productionReady: verified && blockingWarnings.length === 0, blockingWarnings: compilerBlockers },
    createMediaQaContext(mediaAnalysis, project, renderManifestPath)
  );
  const repairPlan = createRepairPlan(qaResult, {
    attempt: Number.isInteger(options.repairAttempt) ? options.repairAttempt : 0,
    maxAttempts: Number.isInteger(options.maxRepairAttempts) ? options.maxRepairAttempts : 2
  });
  manifest.qa = qaResult;
  manifest.repairPlan = repairPlan;
  manifest.productionReady = qaResult.passed && verified && blockingWarnings.length === 0;
  if (typeof options.visualCriticProvider === 'function') {
    manifest.visualCritic = await runVisualCritic({
      provider: options.visualCriticProvider,
      frames: frameEvidence.filter(frame => frame.decoded),
      projectBrief: project.creative?.visualDirection || project.creative?.concept || '',
      signal
    });
  }
  await writeFile(renderManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'qa-report.json'), JSON.stringify(qaResult, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'repair-plan.json'), JSON.stringify(repairPlan, null, 2) + '\n');
  const qaProject = persistQaRecord(project, {
    run: { id: project.project.id + '-' + Date.now(), renderManifest: path.basename(renderManifestPath) },
    qaResult: { ...qaResult, productionReady: manifest.productionReady },
    repairPlan
  });
  await writeFile(path.join(outputRoot, 'project-with-qa.json'), JSON.stringify(qaProject, null, 2) + '\n');
  // Callers driving their own repair loop can pass throwOnQaFailure: false and
  // inspect manifest.qa / manifest.repairPlan instead of catching the throw.
  if (throwOnQaFailure && !manifest.productionReady) throw new Error('Rendered media failed deterministic QA. See QA report: ' + path.join(outputRoot, 'qa-report.json'));
  return manifest;
}

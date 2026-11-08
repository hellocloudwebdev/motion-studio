import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, access, stat, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileHyperFramesProject } from '../../hyperframes-adapter/src/index.mjs';
import { parseProbeOutput } from '../../ffmpeg/src/index.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

  const compile = await compileHyperFramesProject(project, {
    outputDir: engineRoot,
    sourceRoot: options.sourceRoot || projectRoot,
    sceneIds: options.sceneIds,
    allowMissingAssetsAsPlaceholders: options.allowMissingAssetsAsPlaceholders !== false
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
  const expectedIrDuration = Number(project.project.totalDurationFrames) * project.project.frameRate.denominator / project.project.frameRate.numerator;
  // Sample each scene at its midpoint. Avoid the nominal last frame, which may
  // fall past the last decodable frame when container durations are rounded.
  const sampleEnd = Math.max(0, fullDurationSeconds - 2 / fps.value);
  let nextSceneStart = 0;
  const sceneSamples = (project.scenes || []).slice(0, 12).map(scene => {
    const start = Number.isInteger(scene.startFrame) ? scene.startFrame : nextSceneStart;
    nextSceneStart = Math.max(nextSceneStart, start + scene.durationFrames);
    return Math.min(sampleEnd, (start + scene.durationFrames / 2) / fps.value);
  });
  const snapshotTimes = options.snapshotTimes || [...new Set(sceneSamples.length ? sceneSamples : [fullDurationSeconds / 2])];
  await execute('snapshot', ['snapshot', engineRoot, '--at', snapshotTimes.map(x => Number(x).toFixed(3)).join(',')]);

  const outputFile = path.join(outputRoot, (project.project.id || 'motion-studio') + '-' + quality + '.mp4');
  await rm(outputFile, { force: true });
  await execute('render', ['render', '--output', outputFile, '--fps', fps.argument, '--quality', quality, '--workers', String(workerCount), '--low-memory-mode']);
  const outputStat = await stat(outputFile);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error('HyperFrames did not produce a non-empty MP4 at ' + outputFile);

  const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputFile], { cwd: outputRoot, signal });
  const media = parseProbeOutput(probe.stdout);
  const expectedWidth = Number(project.project.canvas.width);
  const expectedHeight = Number(project.project.canvas.height);
  const expectedDuration = fullDurationSeconds;
  const checks = {
    dimensionsMatch: media.width === expectedWidth && media.height === expectedHeight,
    frameRateMatch: (() => { const [n, d = '1'] = String(media.frameRate).split('/'); return Math.abs(Number(n) / Number(d) - fps.value) < 0.001; })(),
    durationWithinOneFrame: Math.abs(media.durationSeconds - expectedDuration) <= 1 / fps.value + 0.02,
    irSceneDurationMatchesProject: Math.abs(expectedDuration - expectedIrDuration) <= 0.5 / fps.value,
    hasVideo: Boolean(media.width && media.height && media.videoCodec),
    nonEmpty: outputStat.size > 0,
    hyperFramesCheckPassed: checkReport.ok !== false && Number(checkReport.errorCount || 0) === 0
  };
  const inspectionDir = path.join(outputRoot, 'qa-frames');
  await mkdir(inspectionDir, { recursive: true });
  const frameEvidence = [];
  for (let i = 0; i < snapshotTimes.length; i += 1) {
    const at = Math.max(0, Math.min(expectedDuration - 1 / fps.value, Number(snapshotTimes[i])));
    const framePath = path.join(inspectionDir, 'frame-' + String(i + 1).padStart(2, '0') + '.png');
    const ffmpeg = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', outputFile, '-frames:v', '1', '-update', '1', framePath], { cwd: outputRoot, signal });
    let frameStat;
    try { frameStat = await stat(framePath); }
    catch { throw new Error('FFmpeg could not decode QA sample at ' + at.toFixed(3) + 's from rendered output: ' + outputFile); }
    frameEvidence.push({ atSeconds: at, path: framePath, bytes: frameStat.size, decoded: frameStat.size > 0, ffmpegExitCode: ffmpeg.code });
  }
  const verified = Object.values(checks).every(Boolean) && frameEvidence.every(x => x.decoded);
  const blockingWarnings = compile.warnings.filter(x => ['ASSET_REFERENCE_MISSING', 'ASSET_FILE_MISSING', 'EXTERNAL_ASSET', 'NON_HYPERFRAMES_LAYER', 'UNSUPPORTED_LAYER_KIND'].includes(x.code));
  const manifest = {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    projectIrSha256: createHash('sha256').update(JSON.stringify(project)).digest('hex'),
    engine: 'hyperframes',
    hyperframesVersion: cli.version,
    output: outputFile,
    bytes: outputStat.size,
    quality,
    fps: fps.value,
    fpsRational: fps.argument,
    workers: workerCount,
    media,
    checks,
    hyperFramesCheck: { path: checkReportPath, issues: checkReport },
    hyperFramesLint: { output: lint.stdout, exitCode: 0 },
    frameEvidence,
    compileWarnings: compile.warnings,
    blockingWarnings,
    steps,
    completedAt: new Date().toISOString(),
    verified,
    productionReady: verified && blockingWarnings.length === 0
  };
  await writeFile(path.join(outputRoot, path.basename(outputFile) + '.render.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (!verified) throw new Error('Rendered media failed output contract inspection. See render manifest: ' + path.join(outputRoot, path.basename(outputFile) + '.render.json'));
  return manifest;
}

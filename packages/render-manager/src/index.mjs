import { spawn } from 'node:child_process';
import { mkdir, access, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compileHyperFramesProject } from '../../hyperframes-adapter/src/index.mjs';
import { parseProbeOutput } from '../../ffmpeg/src/index.mjs';

const require = createRequire(import.meta.url);
const hyperframesEntry = require.resolve('hyperframes');

function run(command, args, { cwd, env = process.env, onLine = () => {}, signal, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; onLine({ stream: 'stdout', text: chunk }); });
    child.stderr.on('data', chunk => { stderr += chunk; onLine({ stream: 'stderr', text: chunk }); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(command + ' ' + args.join(' ') + ' failed with exit code ' + code + '\n' + stderr));
    });
  });
}

export async function renderHyperFramesProject(project, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const engineRoot = path.resolve(options.engineRoot || path.join(projectRoot, 'engines', 'hyperframes'));
  const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'renders'));
  const workerCount = Math.max(1, Math.min(4, Number(options.workers || 1)));
  const quality = options.quality || 'draft';
  const fps = project.project.frameRate.numerator / project.project.frameRate.denominator;
  if (![24, 30, 60].includes(fps)) throw new Error('HyperFrames 0.8.86 CLI supports output FPS 24, 30 or 60; this project uses ' + fps + '. Add an explicit frame-rate conversion stage before rendering.');
  const onLine = options.onLine || (() => {});
  const signal = options.signal;
  await mkdir(outputRoot, { recursive: true });

  const compile = await compileHyperFramesProject(project, {
    outputDir: engineRoot,
    sourceRoot: options.sourceRoot || projectRoot,
    sceneIds: options.sceneIds,
    allowMissingAssetsAsPlaceholders: true
  });
  const steps = [];
  const execute = async (name, args, allowFailure = false) => {
    const result = await run(process.execPath, [hyperframesEntry, ...args], {
      cwd: engineRoot,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' },
      onLine,
      signal,
      allowFailure
    });
    steps.push({ name, args, exitCode: result.code, optional: allowFailure });
    if (result.code !== 0 && !allowFailure) throw new Error('HyperFrames ' + name + ' failed.');
    return result;
  };

  await execute('doctor', ['doctor'], true);
  await execute('lint', ['lint', engineRoot, '--json']);
  const fullDurationSeconds = project.project.totalDurationFrames * project.project.frameRate.denominator / project.project.frameRate.numerator;
  const snapshotTimes = options.snapshotTimes || [...new Set([0, Math.max(0, fullDurationSeconds / 2), Math.max(0, fullDurationSeconds - 1 / fps)])];
  await execute('snapshot', ['snapshot', engineRoot, '--at', snapshotTimes.map(x => Number(x).toFixed(3)).join(',')]);

  const outputFile = path.join(outputRoot, (project.project.id || 'motion-studio') + '-' + quality + '.mp4');
  await execute('render', ['render', '--output', outputFile, '--fps', String(fps), '--quality', quality, '--workers', String(workerCount)]);
  const outputStat = await stat(outputFile);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error('HyperFrames did not produce a non-empty MP4 at ' + outputFile);

  const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputFile], { cwd: outputRoot, signal });
  const media = parseProbeOutput(probe.stdout);
  const expectedWidth = Number(project.project.canvas.width);
  const expectedHeight = Number(project.project.canvas.height);
  const expectedDuration = fullDurationSeconds;
  const checks = {
    dimensionsMatch: media.width === expectedWidth && media.height === expectedHeight,
    frameRateMatch: (() => { const [n, d = '1'] = String(media.frameRate).split('/'); return Math.abs(Number(n) / Number(d) - fps) < 0.001; })(),
    durationWithinOneFrame: Math.abs(media.durationSeconds - expectedDuration) <= 1 / fps + 0.02,
    hasVideo: Boolean(media.width && media.height && media.videoCodec),
    nonEmpty: outputStat.size > 0
  };
  const inspectionDir = path.join(outputRoot, 'qa-frames');
  await mkdir(inspectionDir, { recursive: true });
  const frameEvidence = [];
  for (let i = 0; i < snapshotTimes.length; i += 1) {
    const at = Math.max(0, Math.min(expectedDuration - 1 / fps, Number(snapshotTimes[i])));
    const framePath = path.join(inspectionDir, 'frame-' + String(i + 1).padStart(2, '0') + '.png');
    const ffmpeg = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', outputFile, '-frames:v', '1', '-update', '1', framePath], { cwd: outputRoot, signal });
    const frameStat = await stat(framePath);
    frameEvidence.push({ atSeconds: at, path: framePath, bytes: frameStat.size, decoded: frameStat.size > 0, ffmpegExitCode: ffmpeg.code });
  }
  const verified = Object.values(checks).every(Boolean) && frameEvidence.every(x => x.decoded);
  const blockingWarnings = compile.warnings.filter(x => ['ASSET_REFERENCE_MISSING', 'ASSET_FILE_MISSING', 'EXTERNAL_ASSET', 'NON_HYPERFRAMES_LAYER', 'UNSUPPORTED_LAYER_KIND'].includes(x.code));
  const manifest = {
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    engine: 'hyperframes',
    hyperframesVersion: '0.8.86',
    output: outputFile,
    bytes: outputStat.size,
    quality,
    fps,
    workers: workerCount,
    media,
    checks,
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

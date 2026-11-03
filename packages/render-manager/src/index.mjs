import { spawn } from 'node:child_process';
import { mkdir, access, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileHyperFramesProject } from '../../hyperframes-adapter/src/index.mjs';

function run(executable, args, { cwd, env = process.env, onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; onLine({ stream: 'stdout', text: chunk }); });
    child.stderr.on('data', chunk => { stderr += chunk; onLine({ stream: 'stderr', text: chunk }); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(executable + ' ' + args.join(' ') + ' failed with exit code ' + code + '\n' + stderr));
    });
  });
}

function resolveHyperframesBin(root) {
  const name = process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes';
  return path.join(root, 'node_modules', '.bin', name);
}

export async function renderHyperFramesProject(project, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const engineRoot = path.resolve(options.engineRoot || path.join(projectRoot, 'engines', 'hyperframes'));
  const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'renders'));
  const workerCount = Math.max(1, Math.min(1, Number(options.workers || 1)));
  const quality = options.quality || 'draft';
  const fps = Math.round(project.project.frameRate.numerator / project.project.frameRate.denominator);
  const onLine = options.onLine || (() => {});
  const signal = options.signal;
  await mkdir(outputRoot, { recursive: true });
  const compile = await compileHyperFramesProject(project, {
    outputDir: engineRoot,
    sourceRoot: options.sourceRoot || projectRoot,
    sceneIds: options.sceneIds
  });
  const bin = resolveHyperframesBin(options.installRoot || process.cwd());
  try { await access(bin); }
  catch { throw new Error('HyperFrames CLI was not found at ' + bin + '. Run npm install before rendering.'); }

  const steps = [];
  const execute = async (name, args) => {
    const result = await run(bin, args, { cwd: engineRoot, env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' }, onLine, signal });
    steps.push({ name, args, exitCode: result.code });
    return result;
  };

  await execute('doctor', ['doctor']);
  await execute('lint', ['lint', engineRoot, '--json']);
  const snapshotTimes = options.snapshotTimes || [0, Math.max(0.1, (project.project.totalDurationFrames * project.project.frameRate.denominator / project.project.frameRate.numerator) / 2)];
  await execute('snapshot', ['snapshot', engineRoot, '--at', snapshotTimes.map(x => Number(x).toFixed(3)).join(',')]);
  const outputFile = path.join(outputRoot, (project.project.id || 'motion-studio') + '-' + quality + '.mp4');
  await execute('render', ['render', '--output', outputFile, '--fps', String(fps), '--quality', quality, '--workers', String(workerCount)]);

  const outputStat = await stat(outputFile);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error('HyperFrames did not produce a non-empty MP4 at ' + outputFile);
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
    compileWarnings: compile.warnings,
    steps,
    completedAt: new Date().toISOString(),
    verified: true
  };
  await writeFile(path.join(outputRoot, path.basename(outputFile) + '.render.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

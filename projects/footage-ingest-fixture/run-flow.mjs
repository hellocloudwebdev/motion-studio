// P3.2 real-footage flow: ingest -> trim -> editorial assembly -> verification.
// Generates the testsrc2 fixture if missing, then ingests it, cuts two frame-exact
// ranges, writes the 3-clip Canonical IR (project.json), assembles and validates the
// editorial manifest, and verifies in-points/sync against the rendered trim outputs.
// All local media execution uses fixed executables with argv arrays (no shell).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingestFootage, trimFootage } from '../../packages/media-derivatives/src/index.mjs';
import { createEditorialAssembly, validateEditorialAssembly } from '../../packages/editorial-assembly/src/index.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(projectRoot, 'footage', 'testsrc2-6s-640x360-30fps.mp4');
const rendersDir = path.join(projectRoot, 'renders');
const startTime = process.hrtime.bigint();
const elapsedSeconds = () => Number(process.hrtime.bigint() - startTime) / 1e9;
const evidence = { steps: [], failures: [] };
const step = (name, detail) => {
  evidence.steps.push({ name, detail, atSeconds: Number(elapsedSeconds().toFixed(3)) });
  console.log('[flow] ' + name + ' ' + JSON.stringify(detail));
};
const fail = message => {
  evidence.failures.push(message);
  console.error('[flow] FAIL ' + message);
};

function requireMediaTools() {
  for (const executable of ['ffmpeg', 'ffprobe']) {
    if (spawnSync(executable, ['-version'], { shell: false, stdio: 'ignore' }).status !== 0) {
      throw new Error(executable + ' is not on PATH; the footage flow requires FFmpeg 6+.');
    }
  }
}

function extractRawFrame(file, frameIndex, targetPath) {
  const extracted = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'select=eq(n\\,' + frameIndex + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', targetPath],
  { shell: false, stdio: 'ignore', timeout: 60000 });
  if (extracted.status !== 0) throw new Error('FFmpeg could not extract frame ' + frameIndex + ' from ' + file + '.');
  return targetPath;
}

function psnrBetween(fileA, frameA, fileB, frameB, width, height, scratchName) {
  const scratch = path.join(projectRoot, '.flow-scratch');
  const planA = { file: fileA, frame: frameA, path: path.join(scratch, scratchName + '-a.yuv') };
  const planB = { file: fileB, frame: frameB, path: path.join(scratch, scratchName + '-b.yuv') };
  for (const plan of [planA, planB]) extractRawFrame(plan.file, plan.frame, plan.path);
  return Promise.all([readFile(planA.path), readFile(planB.path)]).then(([a, b]) => {
    if (a.length !== b.length || a.length !== width * height * 1.5) throw new Error('Unexpected raw frame size while comparing ' + scratchName + '.');
    let sumSquaredError = 0n;
    for (let index = 0; index < a.length; index += 1) {
      const delta = a[index] - b[index];
      sumSquaredError += BigInt(delta * delta);
    }
    const mse = Number(sumSquaredError) / a.length;
    return { mse, psnr: mse > 0 ? 10 * Math.log10(255 * 255 / mse) : Infinity };
  });
}

const assertAtLeast = (value, floor, message) => {
  if (!(value >= floor)) fail(message + ' (psnr ' + value.toFixed(2) + 'dB < ' + floor + 'dB)');
  return Number(value.toFixed(2));
};
const assertAtMost = (value, ceiling, message) => {
  if (!(value <= ceiling)) fail(message + ' (psnr ' + value.toFixed(2) + 'dB > ' + ceiling + 'dB)');
  return Number(value.toFixed(2));
};

// Clip plan: two rendered trims back the three edit clips.
// trim-a covers source frames [30, 90), trim-b covers [120, 180).
// clip-a [30,70), clip-b [50,90) come from trim-a; clip-c [120,160) comes from trim-b.
const trims = [
  { id: 'trim-a', startFrame: 30, durationFrames: 60, output: path.join(rendersDir, 'trim-a-in000030-len0060.mp4') },
  { id: 'trim-b', startFrame: 120, durationFrames: 60, output: path.join(rendersDir, 'trim-b-in000120-len0060.mp4') }
];
const clipPlan = [
  { id: 'clip-a', inFrame: 30, durationFrames: 40, scene: 'scene-01' },
  { id: 'clip-b', inFrame: 50, durationFrames: 40, scene: 'scene-02' },
  { id: 'clip-c', inFrame: 120, durationFrames: 40, scene: 'scene-03' }
];

requireMediaTools();
let manifest;

try {
  await mkdir(path.join(projectRoot, 'footage'), { recursive: true });
  await mkdir(rendersDir, { recursive: true });
  await mkdir(path.join(projectRoot, '.flow-scratch'), { recursive: true });

  if (!existsSync(fixturePath)) {
    const made = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=6',
      '-t', '6', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', fixturePath
    ], { shell: false, stdio: 'ignore', timeout: 120000 });
    if (made.status !== 0) throw new Error('FFmpeg could not generate the 6s testsrc2 fixture.');
    step('fixture-generated', { path: path.relative(projectRoot, fixturePath) });
  } else {
    step('fixture-reused', { path: path.relative(projectRoot, fixturePath) });
  }

  manifest = await ingestFootage({ sourcePath: fixturePath, projectRoot, fps: { numerator: 30, denominator: 1 }, overwrite: true });
  step('ingested', {
    sha256: manifest.sha256,
    rationalFps: manifest.rationalFps,
    frameCount: manifest.frameCount,
    durationSeconds: manifest.durationSeconds,
    derivatives: manifest.derivatives.map(item => ({ kind: item.kind, byteSize: item.byteSize })),
    frameRateMatch: manifest.frameRateMatch
  });

  const trimResults = {};
  for (const trim of trims) {
    const result = await trimFootage({
      sourcePath: fixturePath, outputPath: trim.output,
      startFrame: trim.startFrame, durationFrames: trim.durationFrames,
      fps: { numerator: 30, denominator: 1 }
    });
    trimResults[trim.id] = result;
    step('trimmed', {
      id: trim.id,
      startFrame: result.startFrame,
      durationFrames: result.durationFrames,
      outputFrameCount: result.output.frameCount,
      startSeconds: result.startSeconds,
      audioDurationSeconds: result.verified.audioDurationSeconds,
      sha256: result.output.sha256
    });
  }

  // In-point verification against rendered output: the first frame of each trim must
  // match its declared source frame (high PSNR) and differ from source frame 0.
  const frameChecks = {};
  for (const trim of trims) {
    const versusInPoint = await psnrBetween(trim.output, 0, fixturePath, trim.startFrame, manifest.width, manifest.height, trim.id + '-in');
    const versusFirst = await psnrBetween(trim.output, 0, fixturePath, 0, manifest.width, manifest.height, trim.id + '-first');
    frameChecks[trim.id] = {
      versusSourceFrameAtInPoint: assertAtLeast(versusInPoint.psnr, 30, trim.id + ' first frame must match source frame ' + trim.startFrame),
      versusSourceFrameZero: assertAtMost(versusFirst.psnr, 25, trim.id + ' first frame must differ from source frame 0')
    };
  }
  step('in-points-verified', frameChecks);

  const project = {
    schemaVersion: '1.0.0',
    project: {
      id: 'footage-ingest-fixture',
      name: 'Real-footage ingest and frame-accurate trim fixture',
      objective: 'Exercise P3.2 footage ingest, probe, proxy derivatives and frame-accurate editorial trims end to end.',
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 640, height: 360, pixelAspectRatio: 1, safeAreaPercent: 5 },
      totalDurationFrames: clipPlan.length * 40,
      colorSpace: 'Rec.709',
      revision: 1
    },
    assets: [{
      id: 'footage-testsrc2',
      uri: path.relative(projectRoot, fixturePath).replaceAll('\\', '/'),
      sha256: manifest.sha256,
      metadata: {
        rightsStatus: 'approved',
        footage: {
          frameCount: manifest.frameCount,
          rationalFps: manifest.rationalFps,
          durationSeconds: manifest.durationSeconds,
          manifestPath: path.relative(projectRoot, path.join(manifest.outputDirectory, 'manifest.json')).replaceAll('\\', '/')
        }
      }
    }],
    scenes: clipPlan.map((clip, index) => ({
      id: clip.scene,
      name: 'Footage clip ' + clip.id,
      startFrame: index * 40,
      durationFrames: 40,
      intent: 'Exercise the declared source in-point ' + clip.inFrame + ' against the rendered trim outputs.',
      layers: [{
        id: clip.id,
        kind: 'video',
        sourceAssetId: 'footage-testsrc2',
        inFrame: clip.inFrame,
        startFrame: 0,
        durationFrames: clip.durationFrames
      }]
    })),
    delivery: {
      primaryTargetId: 'master-16x9',
      targets: [{ id: 'master-16x9', format: 'mp4', width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, videoCodec: 'libx264', audioCodec: 'aac', colorSpace: 'Rec.709', alpha: false, audioRequired: false }]
    }
  };
  const projectPath = path.join(projectRoot, 'project.json');
  await writeFile(projectPath, JSON.stringify(project, null, 2) + '\n');
  step('ir-written', { path: path.relative(projectRoot, projectPath), clips: clipPlan.map(clip => clip.id + '@in' + clip.inFrame + '+' + clip.durationFrames) });

  const assembly = createEditorialAssembly(project, { sequenceName: 'footage-ingest-fixture-sequence' });
  const validation = validateEditorialAssembly(assembly);
  await writeFile(path.join(projectRoot, 'assembly.json'), JSON.stringify({ assembly, validation }, null, 2) + '\n');
  if (!assembly.summary.valid) fail('editorial assembly has errors: ' + JSON.stringify(assembly.issues.filter(item => item.severity === 'error')));
  if (!validation.valid) fail('editorial assembly self-validation failed: ' + JSON.stringify(validation.issues));
  if (assembly.summary.verifiedFootageClipCount !== clipPlan.length) fail('not every declared clip resolved against ingested footage metadata');
  step('editorial-assembled', {
    valid: assembly.summary.valid,
    errors: assembly.summary.errors,
    warnings: assembly.summary.warnings,
    footageClipCount: assembly.summary.footageClipCount,
    verifiedFootageClipCount: assembly.summary.verifiedFootageClipCount,
    clips: assembly.clips.map(clip => ({ clipId: clip.clipId, track: clip.track, inFrame: clip.inFrame, sourceInPointSeconds: clip.sourceInPointSeconds, sourceOutPointSeconds: clip.sourceOutPointSeconds, footageVerified: clip.footageVerified }))
  });

  // Editorial-manifest verification against rendered output: every clip's declared
  // range must be covered by a rendered trim whose material matches the source frames.
  const coverageChecks = {};
  for (const clip of clipPlan) {
    const coveringTrim = trims.find(trim => clip.inFrame >= trim.startFrame && clip.inFrame + clip.durationFrames <= trim.startFrame + trim.durationFrames);
    if (!coveringTrim) { fail('clip ' + clip.id + ' is not covered by a rendered trim'); continue; }
    const offset = clip.inFrame - coveringTrim.startFrame;
    const match = await psnrBetween(coveringTrim.output, offset, fixturePath, clip.inFrame, manifest.width, manifest.height, clip.id + '-cover');
    coverageChecks[clip.id] = {
      coveredBy: coveringTrim.id,
      trimOffsetFrame: offset,
      psnr: assertAtLeast(match.psnr, 30, clip.id + ' material at in-point ' + clip.inFrame + ' must match ' + coveringTrim.id + ' frame ' + offset)
    };
  }
  step('coverage-verified', coverageChecks);

  step('flow-complete', { totalSeconds: Number(elapsedSeconds().toFixed(3)) });
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
} finally {
  const { rmSync } = await import('node:fs');
  rmSync(path.join(projectRoot, '.flow-scratch'), { recursive: true, force: true });
}

if (evidence.failures.length) {
  console.error(JSON.stringify({ failures: evidence.failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log('[flow] evidence ' + JSON.stringify(evidence));
}

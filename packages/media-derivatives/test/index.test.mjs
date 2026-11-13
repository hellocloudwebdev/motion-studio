import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateMediaDerivatives, ingestFootage, trimFootage } from '../src/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'motion-studio-derivatives-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: false }).status === 0;

function generateTestFootage(root, name, { seconds = 5, rate = '30', size = '320x180', audio = false, metadata = [] } = {}) {
  const target = path.join(root, name);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=' + size + ':rate=' + rate];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=' + seconds);
  for (const [key, value] of metadata) args.push('-metadata', key + '=' + value);
  args.push('-t', String(seconds), '-map', '0:v');
  if (audio) args.push('-map', '1:a');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '64k');
  args.push('-y', target);
  const made = spawnSync('ffmpeg', args, { shell: false, stdio: 'ignore', timeout: 120000 });
  if (made.status !== 0) throw new Error('FFmpeg could not generate the ' + name + ' fixture.');
  return target;
}

function extractRawFrame(file, frameIndex, targetPath) {
  const extracted = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'select=eq(n\\,' + frameIndex + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', targetPath], { shell: false, stdio: 'ignore', timeout: 60000 });
  if (extracted.status !== 0) throw new Error('FFmpeg could not extract frame ' + frameIndex + ' from ' + file + '.');
}

function extractTo(root, file, frameIndex, name) {
  const targetPath = path.join(root, name);
  extractRawFrame(file, frameIndex, targetPath);
  return targetPath;
}

function rawFrameMismatch(bufferA, bufferB) {
  assert.equal(bufferA.length, bufferB.length);
  let sumSquaredError = 0n;
  for (let index = 0; index < bufferA.length; index += 1) {
    const delta = bufferA[index] - bufferB[index];
    sumSquaredError += BigInt(delta * delta);
  }
  const mse = Number(sumSquaredError) / bufferA.length;
  return { mse, psnr: mse > 0 ? 10 * Math.log10(255 * 255 / mse) : Infinity };
}

async function probeFrameCount(file) {
  const probed = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', file], { shell: false, encoding: 'utf8', timeout: 60000 });
  assert.equal(probed.status, 0);
  const stream = JSON.parse(probed.stdout).streams[0];
  return { frameCount: Number(stream.nb_read_frames), width: stream.width, height: stream.height };
}

test('rejects unsupported files and invalid profiles before invoking media tools', async () => fixture(async root => {
  const source = path.join(root, 'notes.txt');
  await writeFile(source, 'not media');
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'out')), /Unsupported media type/);
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'out'), { profile: 'fastest' }), /profile must be/);
}));

test('rejects symlinked sources', { skip: process.platform === 'win32' }, async () => fixture(async root => {
  const source = path.join(root, 'source.mp4');
  const link = path.join(root, 'linked.mp4');
  await writeFile(source, 'source');
  const { symlink } = await import('node:fs/promises');
  await symlink(source, link);
  await assert.rejects(generateMediaDerivatives(link, path.join(root, 'out')), /regular, non-symlink/);
}));

test('creates deterministic video proxy and thumbnail without mutating source', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = path.join(root, 'sample.mp4');
  const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source], { shell: false, stdio: 'ignore' });
  if (made.status !== 0) return;
  const before = await readFile(source);
  const result = await generateMediaDerivatives(source, path.join(root, 'derived'), { profile: 'all' });
  assert.deepEqual(result.outputs.map(item => item.kind).sort(), ['proxy', 'thumbnail']);
  assert.equal((await readFile(source)).equals(before), true);
  for (const output of result.outputs) {
    assert.ok((await lstat(output.path)).isFile());
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }
  await assert.rejects(generateMediaDerivatives(source, path.join(root, 'derived'), { profile: 'all' }), /already exists/);
}));

test('creates waveform image for audio-only sources', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = path.join(root, 'tone.wav');
  const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', source], { shell: false, stdio: 'ignore' });
  if (made.status !== 0) return;
  const result = await generateMediaDerivatives(source, path.join(root, 'derived'));
  assert.deepEqual(result.outputs.map(item => item.kind), ['waveform']);
  assert.equal(result.outputs[0].mimeType, 'image/png');
}));

test('ingest validates arguments before touching the filesystem', async () => fixture(async root => {
  const source = path.join(root, 'not-media.mp4');
  await writeFile(source, 'placeholder');
  await assert.rejects(ingestFootage({ sourcePath: '  ', projectRoot: root }), /sourcePath is required/);
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: '' }), /projectRoot is required/);
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: root, fps: 0 }), /fps must be/);
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: root, fps: { numerator: 30, denominator: 0 } }), /fps must be/);
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: root, thumbnailAtSeconds: 100000 }), /thumbnailAtSeconds must be/);
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: root, timeoutMs: 0 }), /timeoutMs must be/);
}));

test('rejects trim options that cannot describe an exact frame range', async () => fixture(async root => {
  const source = path.join(root, 'source.mp4');
  await writeFile(source, 'placeholder');
  const output = path.join(root, 'trim.mp4');
  await assert.rejects(trimFootage({ sourcePath: source, outputPath: output, startFrame: -1, durationFrames: 10, fps: 30 }), /startFrame must be/);
  await assert.rejects(trimFootage({ sourcePath: source, outputPath: output, startFrame: 0, durationFrames: 0, fps: 30 }), /durationFrames must be/);
  await assert.rejects(trimFootage({ sourcePath: source, outputPath: output, startFrame: 0, durationFrames: 10, fps: 0 }), /fps must be/);
  await assert.rejects(trimFootage({ sourcePath: source, outputPath: source, startFrame: 0, durationFrames: 10, fps: 30 }), /must differ/);
  await assert.rejects(trimFootage({ sourcePath: path.join(root, 'missing.mp4'), outputPath: output, startFrame: 0, durationFrames: 10, fps: 30 }), /no such file|regular, non-symlink/);
}));

test('ingests real footage with verified half-res proxy, waveform and sanitized manifest', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = generateTestFootage(root, 'source.mp4', { seconds: 2, audio: true, metadata: [['title', 'exotic\r\n<meta>&"'], ['comment', '\u2028embedded']] });
  const manifest = await ingestFootage({ sourcePath: source, projectRoot: path.join(root, 'project'), fps: 30 });
  assert.equal(manifest.frameCount, 60);
  assert.deepEqual(manifest.rationalFps, { numerator: 30, denominator: 1 });
  assert.ok(Math.abs(manifest.durationSeconds - 2) < 0.1);
  assert.deepEqual(manifest.requestedFps, { numerator: 30, denominator: 1 });
  assert.equal(manifest.frameRateMatch, true);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.hasAudio, true);
  assert.deepEqual(manifest.derivatives.map(item => item.kind), ['proxy', 'thumbnail', 'waveform']);
  assert.ok(manifest.outputDirectory.endsWith(path.join('assets', 'footage', manifest.sha256.slice(0, 8))));
  const proxy = manifest.derivatives.find(item => item.kind === 'proxy');
  const probedProxy = await probeFrameCount(proxy.path);
  assert.equal(probedProxy.frameCount, 60, 'edit proxy must keep the exact source frame count');
  assert.equal(probedProxy.width, 160, 'edit proxy must be half resolution');
  assert.equal(probedProxy.height, 90);
  const stored = JSON.parse(await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8'));
  assert.equal(stored.sha256, manifest.sha256);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /exotic|embedded|<meta>/, 'untrusted embedded metadata must never reach the manifest');
  assert.ok(!('tags' in stored));
  await assert.rejects(ingestFootage({ sourcePath: source, projectRoot: path.join(root, 'project'), fps: 30 }), /already ingested/);
}));

test('trims an exact 60-frame range whose first frame matches source frame 30', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = generateTestFootage(root, 'source.mp4', { seconds: 5 });
  const output = path.join(root, 'trim.mp4');
  const result = await trimFootage({ sourcePath: source, outputPath: output, startFrame: 30, durationFrames: 60, fps: { numerator: 30, denominator: 1 } });
  assert.equal(result.output.frameCount, 60);
  assert.equal(result.endFrame, 90);
  assert.equal(result.startSeconds, 1);
  assert.equal(result.durationSeconds, 2);
  assert.deepEqual(result.output.rationalFps, { numerator: 30, denominator: 1 });
  assert.deepEqual(result.verified, { withinSource: true, frameCountExact: true, frameRateUnchanged: true, audioDurationSeconds: null });
  assert.match(result.output.sha256, /^[a-f0-9]{64}$/);
  const trimFirst = await readFile(await extractTo(root, output, 0, 'trim-0.yuv'));
  const sourceFirst = await readFile(await extractTo(root, source, 0, 'source-0.yuv'));
  const sourceIn = await readFile(await extractTo(root, source, 30, 'source-30.yuv'));
  const versusFirst = rawFrameMismatch(trimFirst, sourceFirst);
  const versusInPoint = rawFrameMismatch(trimFirst, sourceIn);
  assert.ok(versusFirst.psnr <= 25, 'trim first frame must differ from source frame 0 (psnr ' + versusFirst.psnr.toFixed(2) + 'dB)');
  assert.ok(versusInPoint.psnr >= 35, 'trim first frame must match source frame 30 (psnr ' + versusInPoint.psnr.toFixed(2) + 'dB)');
}));

test('trims exact ranges at 30000/1001 rational fps and verifies the in-point', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = generateTestFootage(root, 'source-ntsc.mp4', { seconds: 5.02, rate: '30000/1001' });
  const result = await trimFootage({ sourcePath: source, outputPath: path.join(root, 'trim.mp4'), startFrame: 45, durationFrames: 60, fps: { numerator: 30000, denominator: 1001 } });
  assert.equal(result.output.frameCount, 60);
  assert.equal(result.startSeconds, 1.5015);
  assert.deepEqual(result.output.rationalFps, { numerator: 30000, denominator: 1001 });
  const trimFirst = await readFile(await extractTo(root, result.output.path, 0, 'trim-0.yuv'));
  const sourceIn = await readFile(await extractTo(root, source, 45, 'source-45.yuv'));
  assert.ok(rawFrameMismatch(trimFirst, sourceIn).psnr >= 35, 'rational fps in-point must land on source frame 45');
}));

test('trims keep the audio stream synchronized to the requested duration', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = generateTestFootage(root, 'source.mp4', { seconds: 5, audio: true });
  const result = await trimFootage({ sourcePath: source, outputPath: path.join(root, 'trim.mp4'), startFrame: 30, durationFrames: 60, fps: 30 });
  assert.ok(result.verified.audioDurationSeconds !== null, 'trimmed audio stream must survive');
  assert.ok(Math.abs(result.verified.audioDurationSeconds - 2) <= 0.1, 'audio duration must span the trimmed frame range');
}));

test('fails closed when a trim range leaves the source frame count', { skip: !ffmpegAvailable }, async () => fixture(async root => {
  const source = generateTestFootage(root, 'source.mp4', { seconds: 5 });
  await assert.rejects(
    trimFootage({ sourcePath: source, outputPath: path.join(root, 'trim.mp4'), startFrame: 140, durationFrames: 60, fps: 30 }),
    /startFrame 140 \+ durationFrames 60 = 200 frames exceeds source frame count 150/
  );
  await assert.rejects(
    trimFootage({ sourcePath: source, outputPath: path.join(root, 'trim.mp4'), startFrame: 0, durationFrames: 151, fps: 30 }),
    /durationFrames 151 = 151 frames exceeds source frame count 150/
  );
}));

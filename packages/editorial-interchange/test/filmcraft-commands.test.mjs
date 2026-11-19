import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { importInterchangeIntoFilmCraft, applyFilmCraftTransition, resolveFilmcraftCommand } from '../src/filmcraft-commands.mjs';
import { craftCommandCandidates } from '../../craft-mcp-client/src/index.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '../../..');
const CLI = path.join(REPO_ROOT, 'apps/cli/src/index.mjs');

test('importInterchangeIntoFilmCraft requires an existing FCPXML and a project path', async () => {
  await assert.rejects(() => importInterchangeIntoFilmCraft({ fcpxmlPath: '', projectPath: 'x.fcproj' }), /FCPXML interchange path/);
  await assert.rejects(() => importInterchangeIntoFilmCraft({ fcpxmlPath: 'D:/does-not-exist.fcpxml', projectPath: 'x.fcproj' }), /does not exist/);
  await assert.rejects(() => importInterchangeIntoFilmCraft({ fcpxmlPath: 'D:/does-not-exist.fcpxml', projectPath: '' }), /target .fcproj project path/);
});

// Live handoff test: runs only where filmcraft-cli is installed (the
// producer's workstation); CI skips it like the other runtime-gated suites.
async function filmcraftAvailable() {
  return craftCommandCandidates({ app: 'filmcraft' }).some(candidate => existsSync(candidate));
}

test('live handoff imports a Motion Studio FCPXML into a real FilmCraft project', { skip: await filmcraftAvailable() ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fc-handoff-live-'));
  try {
    await mkdir(path.join(root, 'media'), { recursive: true });
    const clipPath = path.join(root, 'media', 'clip.mp4');
    const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (fixture.status !== 0) throw new Error('ffmpeg fixture failed: ' + fixture.stderr);
    const sha = createHash('sha256').update(await readFile(clipPath)).digest('hex');

    // Minimal Motion Studio project whose editorial plan references the real clip.
    const project = {
      schemaVersion: '1.0.0',
      project: { id: 'fc-handoff', name: 'Handoff Fixture', objective: 'Verify the FCPXML handoff.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 1 },
      creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
      brand: { colors: { background: '#101820', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
      assets: [{ id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: sha, byteSize: (await stat(clipPath)).size, rightsStatus: 'user-owned' }],
      scenes: [{ id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show the clip.', layers: [{ id: 'l-clip', kind: 'video', assetId: 'clip', transform: { x: 0, y: 0, width: 320, height: 180 } }] }],
      audio: { tracks: [] },
      delivery: { targets: [{ width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } }] }
    };
    await writeFile(path.join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    const plan = spawnSync(process.execPath, [CLI, 'editorial', 'plan', path.join(root, 'project.json'), '--output', path.join(root, 'assembly.json')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (plan.status !== 0) throw new Error('editorial plan failed: ' + plan.stdout + plan.stderr);
    const exportRun = spawnSync(process.execPath, [CLI, 'interchange', 'export', path.join(root, 'assembly.json'), '--asset-root', root, '--output', path.join(root, 'ms.fcpxml')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (exportRun.status !== 0) throw new Error('interchange export failed: ' + exportRun.stdout + exportRun.stderr);

    const result = await importInterchangeIntoFilmCraft({ fcpxmlPath: path.join(root, 'ms.fcpxml'), projectPath: path.join(root, 'handoff.fcproj') });
    assert.equal(result.ok, true);
    assert.equal(result.linkedMedia, 1, 'the imported sequence links the referenced media');
    assert.deepEqual(result.offlineMedia, [], 'no offline media: the FCPXML file: source resolved');
    assert.ok(Number.isInteger(result.sequenceId), 'the imported sequence id is reported');
    assert.ok(existsSync(result.projectPath), 'the .fcproj exists on disk');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// M1.4 FilmCraft depth: transitions across clip boundaries and narration/music
// placement through the FCPXML handoff.

async function filmcraftCliAvailable() {
  try { await resolveFilmcraftCommand(); return true; }
  catch { return false; }
}

test('applyFilmCraftTransition validates its inputs', async () => {
  await assert.rejects(() => applyFilmCraftTransition({ projectPath: '', clipOrdinal: 1 }), /\.fcproj project path/);
  await assert.rejects(() => applyFilmCraftTransition({ projectPath: 'D:/x.fcproj', clipOrdinal: 0 }), /1-based integer/);
  await assert.rejects(() => applyFilmCraftTransition({ projectPath: 'D:/x.fcproj', clipOrdinal: 1, frames: 0 }), /positive integer/);
});

test('live handoff applies a cross dissolve at a clip boundary', { skip: await filmcraftCliAvailable() ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fc-transition-'));
  try {
    const projectPath = path.join(root, 'transition.fcproj');
    const command = await resolveFilmcraftCommand();
    // Phase 1: project + sequence + two demo footage imports. Item ids are
    // runtime-assigned, so they are parsed from the run output.
    const importSteps = [
      JSON.stringify({ id: 'file.newProject', params: { name: 'Transition Fixture' } }),
      JSON.stringify({ id: 'file.newSequence', params: { name: 'T Sequence', width: 320, height: 180, fps: 30 } }),
      JSON.stringify({ id: 'file.importDemoFootage', params: { scene: 'Plasma' } }),
      JSON.stringify({ id: 'file.importDemoFootage', params: { scene: 'Forest' } }),
      JSON.stringify({ id: 'file.saveAs', params: { path: projectPath } })
    ].join('\n');
    const importFile = path.join(root, 'p1.jsonl');
    await writeFile(importFile, importSteps);
    const build = spawnSync(command, ['run', '--commands', importFile], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(build.status, 0, 'imports succeed: ' + (build.stderr || build.stdout).slice(-300));
    const results = build.stdout.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter(entry => entry.ok === true);
    const itemIds = results.filter(entry => entry.id === 'file.importDemoFootage').flatMap(entry => entry.result.items);
    assert.equal(itemIds.length, 2, 'two demo clips imported');
    // Phase 2: open the sequence, place both clips back-to-back on V1, save.
    // Back-to-back (items array) avoids overlaps: each demo clip is ~5 s and
    // placing the second inside the first's span would be refused.
    const sequenceId = results.find(entry => entry.id === 'file.newSequence').result.sequence;
    const placeSteps = [
      JSON.stringify({ id: 'sequence.open', params: { item: sequenceId } }),
      JSON.stringify({ id: 'timeline.place', params: { items: itemIds } }),
      JSON.stringify({ id: 'file.saveAs', params: { path: projectPath } })
    ].join('\n');
    const placeFile = path.join(root, 'p2.jsonl');
    await writeFile(placeFile, placeSteps);
    const place = spawnSync(command, ['--project', projectPath, 'run', '--commands', placeFile], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(place.status, 0, 'clips place: ' + (place.stderr || place.stdout).slice(-300));
    const result = await applyFilmCraftTransition({ projectPath, track: 'V1', clipOrdinal: 1, effect: 'cross_dissolve', frames: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'cross_dissolve');
    assert.equal(result.frames, 12);
    // The transition survives save/reopen.
    const inspect = spawnSync(command, ['--project', projectPath, 'inspect', 'sequence'], { encoding: 'utf8' });
    assert.match(inspect.stdout, /cross_dissolve|transition/i, 'the transition persists in the sequence');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live handoff carries narration/music through FCPXML into the sequence audio track', { skip: await filmcraftCliAvailable() ? false : 'filmcraft-cli is required on the host.' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-fc-audio-'));
  try {
    await mkdir(path.join(root, 'media'), { recursive: true });
    const clipPath = path.join(root, 'media', 'clip.mp4');
    const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (fixture.status !== 0) throw new Error('ffmpeg fixture failed: ' + fixture.stderr);
    const musicPath = path.join(root, 'media', 'music.wav');
    const music = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', musicPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (music.status !== 0) throw new Error('music fixture failed: ' + music.stderr);
    const sha = createHash('sha256').update(await readFile(clipPath)).digest('hex');
    const sha2 = createHash('sha256').update(await readFile(musicPath)).digest('hex');
    const project = {
      schemaVersion: '1.0.0',
      project: { id: 'fc-audio', name: 'FC Audio E2E', objective: 'Verify audio handoff.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 320, height: 180, pixelAspectRatio: 1, safeAreaPercent: 5 }, totalDurationFrames: 60, colorSpace: 'Rec.709', revision: 1 },
      creative: { concept: 'c', audience: 'a', message: 'm', visualDirection: 'v' },
      brand: { colors: { background: '#101820', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
      assets: [
        { id: 'clip', kind: 'video', uri: 'media/clip.mp4', sha256: sha, byteSize: (await stat(clipPath)).size, rightsStatus: 'user-owned' },
        { id: 'music', kind: 'audio', uri: 'media/music.wav', sha256: sha2, byteSize: (await stat(musicPath)).size, rightsStatus: 'user-owned' }
      ],
      scenes: [{ id: 'scene-01', name: 'Scene One', startFrame: 0, durationFrames: 60, intent: 'Show.', layers: [{ id: 'l-clip', kind: 'video', assetId: 'clip', transform: { x: 0, y: 0, width: 320, height: 180 } }] }],
      audio: { tracks: [{ assetId: 'music', kind: 'music', offsetFrames: 0, durationFrames: 60, volume: 0.8 }] },
      delivery: { targets: [{ width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } }] }
    };
    await writeFile(path.join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    const plan = spawnSync(process.execPath, [CLI, 'editorial', 'plan', path.join(root, 'project.json'), '--output', path.join(root, 'assembly.json')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (plan.status !== 0) throw new Error('editorial plan failed: ' + plan.stdout + plan.stderr);
    const exportRun = spawnSync(process.execPath, [CLI, 'interchange', 'export', path.join(root, 'assembly.json'), '--asset-root', root, '--output', path.join(root, 'ms.fcpxml')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (exportRun.status !== 0) throw new Error('interchange export failed: ' + exportRun.stdout + exportRun.stderr);
    const fcpxml = await readFile(path.join(root, 'ms.fcpxml'), 'utf8');
    assert.match(fcpxml, /hasAudio="1"/, 'the FCPXML declares the music asset with audio');
    // Handoff in ONE session (import + saveAs), then verify the audio track.
    const s1 = path.join(root, 'p1.jsonl');
    await writeFile(s1, [
      JSON.stringify({ id: 'file.newProject', params: { name: 'AudioE2E' } }),
      JSON.stringify({ id: 'file.import', params: { paths: [path.join(root, 'ms.fcpxml')] } }),
      JSON.stringify({ id: 'file.saveAs', params: { path: path.join(root, 'imported.fcproj') } })
    ].join('\n'));
    const command = await resolveFilmcraftCommand();
    const r1 = spawnSync(command, ['run', '--commands', s1], { encoding: 'utf8' });
    assert.equal(r1.status, 0, 'the handoff session succeeds');
    const importLine = JSON.parse(r1.stdout.trim().split(/\r?\n/).find(l => l.includes('"file.import"')));
    assert.equal(importLine.result.documents[0].offlineMedia.length, 0, 'audio + video media both resolve');
    const ins = spawnSync(command, ['--project', path.join(root, 'imported.fcproj'), 'inspect', 'sequence'], { encoding: 'utf8' });
    const seq = JSON.parse(ins.stdout.slice(ins.stdout.indexOf('{')));
    const audioItems = (seq.audio || []).reduce((sum, track) => sum + (track.items || []).length, 0);
    assert.ok(audioItems >= 1, 'the imported sequence carries the music on an audio track');
  } finally { await rm(root, { recursive: true, force: true }); }
});

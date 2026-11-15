import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { importInterchangeIntoFilmCraft } from '../src/filmcraft-commands.mjs';
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

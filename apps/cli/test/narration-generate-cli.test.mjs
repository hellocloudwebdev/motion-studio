import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('apps/cli/src/index.mjs');

function envWithoutFishCredentials() {
  const env = { ...process.env };
  delete env.FISH_AUDIO_API_KEY;
  delete env.FISH_API_KEY;
  delete env.FISH_AUDIO_MODEL;
  return env;
}

async function writeSmokeProject(dir) {
  const projectFile = path.join(dir, 'project.json');
  await writeFile(projectFile, JSON.stringify({ project: { id: 'narration-cli-smoke' }, production: { script: [{ narration: 'A short narration line.' }] } }, null, 2) + '\n');
  return projectFile;
}

test('narration-generate rejects an unknown speech provider before touching the workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-narration-'));
  try {
    const projectFile = await writeSmokeProject(dir);
    const result = spawnSync(process.execPath, [cli, 'narration-generate', projectFile, '--speech-provider', 'openai'], { encoding: 'utf8', env: envWithoutFishCredentials(), cwd: dir, shell: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--speech-provider must be "local" or "fish-audio"/);
    assert.equal(existsSync(path.join(dir, 'projects')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('narration-generate only accepts --speech-model together with fish-audio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-narration-'));
  try {
    const projectFile = await writeSmokeProject(dir);
    const result = spawnSync(process.execPath, [cli, 'narration-generate', projectFile, '--speech-model', 's2.1-pro-free'], { encoding: 'utf8', env: envWithoutFishCredentials(), cwd: dir, shell: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--speech-model only applies when --speech-provider is fish-audio/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('narration-generate with fish-audio fails safely when no Fish Audio key is configured and writes nothing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-narration-'));
  try {
    const projectFile = await writeSmokeProject(dir);
    const result = spawnSync(process.execPath, [cli, 'narration-generate', projectFile, '--speech-provider', 'fish-audio'], { encoding: 'utf8', env: envWithoutFishCredentials(), cwd: dir, shell: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FISH_AUDIO_API_KEY \(or FISH_API_KEY\) is required/);
    assert.doesNotMatch(result.stderr, /Bearer |sk-or-v1-|apiKey/);
    assert.equal(existsSync(path.join(dir, 'projects')), false, 'the project workspace must not be created without credentials');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('narration-generate keeps the local speech provider as its default', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-narration-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'narration-generate', path.join(dir, 'missing.json')], { encoding: 'utf8', env: envWithoutFishCredentials(), cwd: dir, shell: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /FISH_AUDIO_API_KEY/, 'the local default must not consult Fish Audio credentials');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

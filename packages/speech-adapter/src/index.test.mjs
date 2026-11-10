import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateSpeech, narrationTextFromProject, resolveSpeechCommand } from './index.mjs';

test('resolves offline TTS through fixed platform executable paths', () => {
  assert.equal(resolveSpeechCommand('win32', { SystemRoot: 'C:\\Windows' }).executable, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.equal(resolveSpeechCommand('darwin').executable, '/usr/bin/say');
  assert.equal(resolveSpeechCommand('linux').executable, '/usr/bin/espeak');
  assert.throws(() => resolveSpeechCommand('freebsd'), /No offline speech adapter/);
});

test('extracts narration from supported planning and production shapes', () => {
  assert.equal(narrationTextFromProject({ production: { script: [{ narration: 'A first line.' }, { narration: 'A second line.' }] } }), 'A first line.\n\nA second line.');
  assert.equal(narrationTextFromProject({ planning: { script: { narrationSegments: [{ text: 'A line.' }] } } }), 'A line.');
  assert.throws(() => narrationTextFromProject({}), /does not contain narration text/);
});

test('generates and independently probes real offline narration inside the project workspace', async t => {
  const command = resolveSpeechCommand();
  try {
    const fs = await import('node:fs/promises');
    await fs.access(command.executable);
    if (process.platform === 'linux') await fs.access(command.executable);
  }
  catch { t.skip('This runner does not have its platform speech engine installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-speech-adapter-'));
  try {
    const output = path.join(root, 'assets', 'narration' + command.extension);
    const result = await generateSpeech('This is a short offline narration verification.', { projectRoot: root, outputPath: output });
    assert.equal(result.verified, true);
    assert.equal(result.provider, command.provider);
    assert.ok(result.audio.durationSeconds > 0);
    assert.ok(result.sha256);
    assert.ok((await stat(output)).size > 0);
    await assert.rejects(generateSpeech('Unsafe output path.', { projectRoot: root, outputPath: path.join(root, '..', 'outside.wav') }), /must remain inside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const cli = path.join(root, 'apps/cli/src/index.mjs');
const project = JSON.parse(readFileSync(path.join(root, 'templates/startup-ad/project.json'), 'utf8'));
// The acceptance template routes every layer to HyperFrames; the production
// graph always adds Premiere editorial assembly and FFmpeg delivery.
const checks = {
  hyperframes: { available: true },
  premiere: { serverConnected: true, hostVerified: true },
  ffmpeg: { available: true }
};

function runPreflight(hostChecks) {
  const dir = mkdtempSync(path.join(tmpdir(), 'motion-studio-preflight-'));
  try {
    const projectPath = path.join(dir, 'project.json'), checksPath = path.join(dir, 'host-checks.json');
    writeFileSync(projectPath, JSON.stringify(project));
    writeFileSync(checksPath, JSON.stringify(hostChecks));
    return spawnSync(process.execPath, [cli, 'preflight', projectPath, '--host-checks', checksPath], { cwd: root, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('CLI preflight succeeds only when all routed and delivery hosts are verified', () => {
  const result = runPreflight(checks);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ready": true/);
});

test('CLI preflight exits non-zero when an engine host is missing', () => {
  const { hyperframes, ...incomplete } = checks;
  const result = runPreflight(incomplete);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stdout, /"ready": false/);
  assert.match(result.stdout, /"hyperframes"/);
});

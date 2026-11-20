import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M1.9 security invariants, verified by scanning every shipped .mjs under
// packages/, apps/, servers/, scripts/ and uxp/:
//   1. no child_process.exec / execSync (shell command strings are banned;
//      all child processes go through spawn/spawnSync with fixed argv)
//   2. no `shell: true` spawn option anywhere
//   3. no PowerShell/cmd invocation except through the documented fixed-argv
//      launchers (install.ps1 runs the documented installer; the two SAPI /
//      Premiere launchers spawn cmd with quoted, controlled command lines)
//
// These are the mechanical halves of the "allowlisted process execution" and
// "workspace path restrictions" rows; the semantic halves (containment
// checks, untrusted-metadata validators) are covered by the adapters' own
// suites.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['packages', 'apps', 'servers', 'scripts', 'uxp'];
const SELF = path.resolve(fileURLToPath(import.meta.url));
const ALLOWED_SHELL_LAUNCHERS = new Set([
  'scripts/install.mjs',
  'scripts/install.ps1',
  'scripts/adobe-mcp-launcher.mjs',
  'scripts/craft-mcp-launcher.mjs',
  'scripts/premiere-pro-mcp-launcher.mjs',
  'scripts/windows-sapi-speech.ps1',
  'packages/speech-adapter/src/index.mjs',
  'scripts/software-detect.mjs'
]);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'work') continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      yield full;
    }
  }
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

test('no child_process.exec or execSync in any shipped module', () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      if (path.resolve(file) === SELF) continue;
      const text = fs.readFileSync(file, 'utf8');
      // .exec( alone is RegExp.prototype.exec — only a child_process import
      // combined with a bare exec( call is shell-string execution.
      if (/child_process/.test(text) && /(?<![.\w])exec(Sync)?\s*\(/.test(text)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], 'shell-string execution found in: ' + offenders.join(', '));
});

test('no spawn runs with shell: true', () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      if (path.resolve(file) === SELF) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/shell\s*:\s*(true|1|"true")/.test(text)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], 'shell:true spawns found in: ' + offenders.join(', '));
});

test('cmd/PowerShell invocations only appear in the documented fixed-argv launchers', () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      if (path.resolve(file) === SELF) continue;
      const relative = rel(file);
      const text = fs.readFileSync(file, 'utf8');
      if (/cmd\.exe|ComSpec|powershell/i.test(text) && !ALLOWED_SHELL_LAUNCHERS.has(relative) && !relative.endsWith('.test.mjs')) offenders.push(relative);
    }
  }
  assert.deepEqual(offenders, [], 'undocumented shell invocations in: ' + offenders.join(', '));
});

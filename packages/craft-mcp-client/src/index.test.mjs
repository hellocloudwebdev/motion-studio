import test from 'node:test';
import assert from 'node:assert/strict';
import { craftCommandCandidates, craftMcpArgs, createCraftMcpEnvironment, createCraftOperationApproval, resolveCraftCommand, validateCraftOperationApproval } from './index.mjs';

test('craft environments pass through without faking read-only switches', () => {
  // Unlike the retired Adobe MCPs, the craft CLIs ship no documented
  // read-only/eval env switches — mutation safety lives in the approval gate,
  // so the environment must pass through verbatim (nothing stripped, nothing
  // invented).
  const env = createCraftMcpEnvironment({ baseEnv: { PATH: '/bin', RANDOM_FLAG: '1' } });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.RANDOM_FLAG, '1');
  assert.equal(Object.keys(createCraftMcpEnvironment({ baseEnv: {} })).length, 0);
});

test('command candidates honor env overrides before PATH and install roots', () => {
  const candidates = craftCommandCandidates({
    app: 'effectcraft',
    env: { EFFECTCRAFT_CLI: 'D:/craft/effectcraft-cli.exe', USERPROFILE: 'C:/Users/Hp' },
    platform: 'win32',
    home: 'C:/Users/Hp'
  });
  assert.equal(candidates[0], 'D:/craft/effectcraft-cli.exe');
  assert.equal(candidates[1], 'effectcraft-cli.exe');
  assert.ok(candidates.some(item => item.includes('Programs') && item.includes('effectcraft-cli.exe')));
  const posix = craftCommandCandidates({ app: 'filmcraft', env: {}, platform: 'linux', home: '/home/dev' });
  assert.deepEqual(posix.slice(0, 3), ['filmcraft-cli', '/usr/local/bin/filmcraft-cli', '/usr/bin/filmcraft-cli']);
});

test('resolveCraftCommand picks the first existing candidate and falls back to PATH', async () => {
  const resolved = await resolveCraftCommand({
    app: 'filmcraft',
    env: { FILMCRAFT_CLI: '/opt/filmcraft/filmcraft-cli' },
    probe: async candidate => candidate === '/opt/filmcraft/filmcraft-cli'
  });
  assert.equal(resolved, '/opt/filmcraft/filmcraft-cli');
  const fallback = await resolveCraftCommand({ app: 'effectcraft', env: {}, probe: async () => false });
  assert.match(fallback, /^effectcraft-cli(\.exe)?$/, 'with nothing on disk the bare PATH-resolvable name is returned');
});

test('MCP argv matches each CLI contract exactly', () => {
  assert.deepEqual(craftMcpArgs('filmcraft'), ['--', 'mcp'], 'FilmCraft exposes headless MCP as `filmcraft-cli -- mcp`');
  assert.deepEqual(craftMcpArgs('effectcraft'), ['mcp'], 'EffectCraft exposes headless MCP as `effectcraft-cli mcp`');
  assert.throws(() => craftMcpArgs('aftereffects'), /effectcraft or filmcraft/);
});

test('craft operation approval is scoped to exact project, run, tool and arguments', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  const args = { sequenceId: 'seq-1', export: { format: 'h264', width: 1920 } };
  const approval = createCraftOperationApproval({ projectId: 'p1', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args, approvedBy: 'producer', now });
  assert.equal(validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args, now }).valid, true);
  assert.equal(validateCraftOperationApproval({ approval, projectId: 'p2', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args, now }).valid, false);
  assert.equal(validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'effectcraft', toolName: 'export_sequence', args, now }).valid, false);
  assert.equal(validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args: { sequenceId: 'other' }, now }).valid, false);
  assert.equal(validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args, now: now + 600001 }).valid, false);
  assert.equal(validateCraftOperationApproval({ approval: null, projectId: 'p1', runId: 'r1', app: 'filmcraft', toolName: 'export_sequence', args, now }).valid, false);
});

test('craft operation approval requires an identified approver and bounded expiry', () => {
  assert.throws(() => createCraftOperationApproval({ projectId: 'p1', runId: 'r1', app: 'effectcraft', toolName: 'save_project', approvedBy: '' }), /approving actor/);
  assert.throws(() => createCraftOperationApproval({ projectId: 'p1', runId: 'r1', app: 'effectcraft', toolName: 'save_project', approvedBy: 'producer', expiresInMs: 7200000 }), /between 1 ms and 1 hour/);
  assert.throws(() => createCraftOperationApproval({ projectId: 'p1', runId: 'r1', app: 'aftereffects', toolName: 'save_project', approvedBy: 'producer' }), /craft app/);
});

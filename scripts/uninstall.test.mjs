import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeUninstallPlan, executeUninstallPlan, loadUninstallRecord } from './uninstall.mjs';

const record = {
  version: '0.9.0',
  installPath: path.resolve('DATA-ROOT', 'motion-studio', 'app'),
  installed: ['ffmpeg:already-present', 'blender'],
  detected: {},
  stagedSkills: { claude: ['motion-studio-after-effects', 'motion-studio-premiere-pro'], codex: ['motion-studio-kinetic-type'], cursor: ['not-ours'], unknownHost: ['motion-studio-x'] },
  hostIntegrations: ['claude-agent-files', 'cursor-mcp:motion-studio,effectcraft,filmcraft,motion-studio-managed-1', 'claude-mcp-config', 'zcode-mcp-config', 'codex-mcp-config', 'deepseek-mcp-config'],
  craftMcp: {}, adobeMcp: {}, needsUserAction: [], warnings: []
};

test('the uninstall plan removes only Motion Studio-owned state and preserves everything else', () => {
  const home = path.resolve('HOME'), configRoot = path.resolve('CONFIG-ROOT');
  const plan = computeUninstallPlan(record, { home, configRoot });
  const kinds = kind => plan.remove.filter(item => item.kind === kind);
  assert.equal(kinds('directory').length, 4, 'app copy + three prefixed skill dirs');
  assert.ok(plan.remove.some(item => item.path === record.installPath));
  assert.ok(plan.remove.some(item => item.path === path.join(home, '.claude', 'skills', 'motion-studio-after-effects')));
  assert.ok(plan.remove.some(item => item.path === path.join(home, '.agents', 'skills', 'motion-studio-kinetic-type')));
  assert.ok(!plan.remove.some(item => item.path && item.path.includes('not-ours')), 'skills without the motion-studio- prefix are never removed');
  assert.ok(plan.warnings.some(item => item.includes('not-ours')));
  assert.ok(plan.warnings.some(item => item.includes('unknownHost')));
  assert.equal(kinds('directory-glob').length, 1, 'claude agent files');
  assert.equal(kinds('file').filter(item => item.path.includes('adapters')).length, 4, 'four recorded adapter configs');
  assert.equal(kinds('mcp-server-keys').length, 1);
  assert.deepEqual(kinds('mcp-server-keys')[0].keys, ['motion-studio', 'effectcraft', 'filmcraft', 'motion-studio-managed-1']);
  assert.equal(kinds('host-cli-registration').length, 2);
  assert.ok(plan.remove.some(item => item.path && item.path.endsWith('install.json')), 'the record itself is removed last');
  assert.ok(plan.preserve.some(item => item.path.includes('secrets')), 'generated token preserved by default');
  assert.ok(plan.preserve.some(item => item.name === 'blender' && item.reason.includes('--remove-system-tools')), 'system tools preserved by default');
  assert.ok(plan.preserve.some(item => item.name === 'ffmpeg' && item.reason.includes('already present')));
});

test('removeSecrets and removeSystemTools flip the corresponding plan entries', () => {
  const plan = computeUninstallPlan(record, { home: path.resolve('H'), configRoot: path.resolve('C'), removeSecrets: true, removeSystemTools: true });
  assert.ok(plan.remove.some(item => item.kind === 'directory' && item.path.includes('secrets')));
  const tools = plan.remove.filter(item => item.kind === 'system-tool').map(item => item.name);
  assert.deepEqual(tools.sort(), ['blender'], 'only installer-installed tools are removable; already-present ones never are');
  assert.ok(plan.preserve.some(item => item.name === 'ffmpeg' && item.reason.includes('already present')));
});

test('a missing or malformed install record fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-uninstall-'));
  try {
    await assert.rejects(() => loadUninstallRecord(path.join(root, 'missing.json')), /No Motion Studio install record/);
    await writeFile(path.join(root, 'bad.json'), '{}');
    await assert.rejects(() => loadUninstallRecord(path.join(root, 'bad.json')), /installPath/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execution removes exactly the plan, preserves user state, and dry-run touches nothing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-uninstall-run-'));
  try {
    const home = path.join(root, 'home'), configRoot = path.join(root, 'config'), dataRoot = path.join(root, 'data');
    const appRoot = path.join(dataRoot, 'motion-studio', 'app');
    // Fake the installed state.
    await mkdir(path.join(appRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(appRoot, 'scripts', 'mcp-launcher.mjs'), 'export {}');
    for (const dir of [path.join(home, '.claude', 'skills', 'motion-studio-after-effects'), path.join(home, '.claude', 'skills', 'user-own-skill'), path.join(home, '.claude', 'agents')]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(home, '.claude', 'agents', 'motion-studio-premiere-editor.md'), 'agent');
    await writeFile(path.join(home, '.claude', 'agents', 'user-own-agent.md'), 'agent');
    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    await mkdir(path.dirname(cursorFile), { recursive: true });
    await writeFile(cursorFile, JSON.stringify({ mcpServers: {
      'motion-studio': { command: path.join(appRoot, 'scripts', 'mcp-launcher.mjs'), args: [] },
      effectcraft: { command: path.join(appRoot, 'scripts', 'craft-mcp-launcher.mjs'), args: ['effectcraft'] },
      'user-own-server': { command: 'node', args: ['user-server.mjs'] },
      'motion-studio-managed-1': { command: path.join(appRoot, 'scripts', 'mcp-launcher.mjs'), args: [] }
    } }, null, 2) + '\n');
    await mkdir(path.join(configRoot, 'motion-studio', 'adapters'), { recursive: true });
    for (const host of ['claude', 'zcode', 'codex', 'deepseek']) await writeFile(path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json'), '{"mcpServers":{}}');
    await mkdir(path.join(configRoot, 'motion-studio', 'secrets'), { recursive: true });
    await writeFile(path.join(configRoot, 'motion-studio', 'secrets', 'premiere-uxp-token'), 'token');
    const localRecord = { ...record, installPath: appRoot };
    const plan = computeUninstallPlan(localRecord, { home, configRoot });
    const cliCalls = [];
    const runHostCli = async (host, name) => { cliCalls.push(host + ':' + name); };

    // Dry run must not touch anything.
    await executeUninstallPlan(plan, { home, configRoot, dryRun: true, runHostCli });
    assert.equal((await readFile(path.join(appRoot, 'scripts', 'mcp-launcher.mjs'))).toString(), 'export {}', 'dry run leaves the app copy');
    assert.deepEqual(JSON.parse(await readFile(cursorFile, 'utf8')).mcpServers['motion-studio'], { command: path.join(appRoot, 'scripts', 'mcp-launcher.mjs'), args: [] }, 'dry run leaves cursor keys');

    cliCalls.length = 0; // the dry run above already recorded its calls
    const results = await executeUninstallPlan(plan, { home, configRoot, runHostCli });
    assert.equal(await statDir(path.join(appRoot, 'scripts', 'mcp-launcher.mjs')), false, 'app copy removed');
    assert.equal(await statDir(path.join(home, '.claude', 'skills', 'motion-studio-after-effects')), false, 'staged skill removed');
    assert.equal(await statDir(path.join(home, '.claude', 'skills', 'user-own-skill')), true, 'user skill preserved');
    assert.equal(await statDir(path.join(home, '.claude', 'agents', 'user-own-agent.md')), true, 'user agent preserved');
    assert.equal(await statDir(path.join(home, '.claude', 'agents', 'motion-studio-premiere-editor.md')), false, 'staged agent removed');
    for (const host of ['claude', 'zcode', 'codex', 'deepseek']) assert.equal(await statDir(path.join(configRoot, 'motion-studio', 'adapters', host + '.mcp.json')), false, host + ' adapter removed');
    assert.equal(await statDir(path.join(configRoot, 'motion-studio', 'secrets', 'premiere-uxp-token')), true, 'token preserved');
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8'));
    assert.equal(cursor.mcpServers['motion-studio'], undefined, 'our cursor key removed');
    assert.equal(cursor.mcpServers['effectcraft'], undefined, 'our cursor key removed (2)');
    assert.equal(cursor.mcpServers['motion-studio-managed-1'], undefined, 'managed cursor key removed');
    assert.deepEqual(cursor.mcpServers['user-own-server'], { command: 'node', args: ['user-server.mjs'] }, 'user cursor key untouched');
    assert.deepEqual(cliCalls.sort(), ['claude:aftereffects', 'claude:effectcraft', 'claude:filmcraft', 'claude:motion-studio', 'claude:premiere-pro', 'codex:aftereffects', 'codex:effectcraft', 'codex:filmcraft', 'codex:motion-studio', 'codex:premiere-pro']);
    assert.equal(results.warnings.length, 2, 'exactly the record-shape warnings: ' + results.warnings.join('; '));
    // install.json removed last: it is in the plan but the fake config never had one — removal is force-safe.
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cursor key the user has since edited is preserved with a warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-uninstall-edit-'));
  try {
    const home = path.join(root, 'home');
    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    await mkdir(path.dirname(cursorFile), { recursive: true });
    await writeFile(cursorFile, JSON.stringify({ mcpServers: { effectcraft: { command: 'C:/somewhere-else/effectcraft-cli.exe', args: [] } } }));
    const plan = computeUninstallPlan({ ...record, hostIntegrations: ['cursor-mcp:effectcraft'] }, { home, configRoot: root });
    const results = await executeUninstallPlan(plan, { home, configRoot: root, runHostCli: async () => {} });
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8'));
    assert.deepEqual(cursor.mcpServers.effectcraft, { command: 'C:/somewhere-else/effectcraft-cli.exe', args: [] }, 'edited key preserved');
    assert.ok(results.warnings.some(item => item.includes('no longer points')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function statDir(target) {
  try { await (await import('node:fs/promises')).stat(target); return true; }
  catch { return false; }
}

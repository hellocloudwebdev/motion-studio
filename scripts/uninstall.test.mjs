import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'motion-studio-uninstall-'));
  const home = path.join(temp, 'home');
  const config = path.join(temp, 'config');
  const data = path.join(home, '.local', 'share');
  const app = path.join(data, 'motion-studio', 'app');
  const record = path.join(config, 'motion-studio', 'install.json');
  await mkdir(path.join(app, 'agents'), { recursive: true });
  await mkdir(path.join(config, 'motion-studio', 'adapters'), { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'skills', 'motion-studio-core'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'agents'), { recursive: true });
  await writeFile(path.join(app, 'agents', 'producer.md'), '# Producer\n');
  await writeFile(path.join(home, '.claude', 'skills', 'motion-studio-core', 'SKILL.md'), '# Skill\n');
  await writeFile(path.join(home, '.claude', 'agents', 'motion-studio-producer.md'), '# Agent\n');
  await writeFile(path.join(config, 'motion-studio', 'adapters', 'claude.mcp.json'), JSON.stringify({ motionStudioManaged: true, mcpServers: {} }));
  await writeFile(path.join(config, 'motion-studio', 'adapters', 'codex.mcp.json'), JSON.stringify({
    mcpServers: {
      user: { command: 'keep' },
      'motion-studio-managed': { command: node, args: [path.join(app, 'scripts', 'mcp-launcher.mjs')] }
    }
  }));
  const cursor = { mcpServers: {
    'motion-studio': { command: node, args: [path.join(app, 'scripts', 'mcp-launcher.mjs')] },
    'my-server': { command: 'my-server', args: ['--safe'] }
  }};
  await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(cursor));
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, JSON.stringify({
    installPath: app,
    stagedSkills: { claude: ['motion-studio-core'], codex: [], codexLegacy: [], cursor: [] }
  }));
  await writeFile(path.join(home, 'keep.txt'), 'user data');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
  if (process.platform === 'win32') {
    env.USERPROFILE = home;
    env.APPDATA = config;
    env.LOCALAPPDATA = data;
  }
  return { temp, home, config, data, app, record, env };
}

test('uninstaller dry run preserves every file', async () => {
  const f = await fixture();
  try {
    const result = spawnSync(node, [path.join(root, 'scripts/uninstall.mjs')], { encoding: 'utf8', env: f.env });
    assert.equal(result.status, 0, result.stderr);
    await access(f.app);
    await access(f.record);
    await access(path.join(f.home, 'keep.txt'));
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('uninstaller removes only Motion Studio-owned files and preserves user config', async () => {
  const f = await fixture();
  try {
    const result = spawnSync(node, [path.join(root, 'scripts/uninstall.mjs'), '--yes'], { encoding: 'utf8', env: f.env });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(f.app));
    await assert.rejects(access(f.record));
    await assert.rejects(access(path.join(f.home, '.claude', 'skills', 'motion-studio-core')));
    await assert.rejects(access(path.join(f.home, '.claude', 'agents', 'motion-studio-producer.md')));
    await assert.rejects(access(path.join(f.config, 'motion-studio', 'adapters', 'claude.mcp.json')));
    const codex = JSON.parse(await readFile(path.join(f.config, 'motion-studio', 'adapters', 'codex.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(codex.mcpServers), ['user']);
    await access(path.join(f.home, 'keep.txt'));
    const cursor = JSON.parse(await readFile(path.join(f.home, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(cursor.mcpServers), ['my-server']);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

const entry = path.resolve('apps/local-runtime/src/server.mjs');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(child) {
  let output = '';
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local runtime did not become ready. Output: ' + output)), 5000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('listening on http://127.0.0.1:')) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Local runtime exited before listening (' + code + '). ' + output)); });
  });
}

test('local runtime requires a strong explicit auth token before starting', async () => {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, MOTION_STUDIO_TOKEN: '' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
});

test('local runtime binds to loopback and authenticates actual API requests', async () => {
  const port = await freePort(), token = 'local-runtime-test-token-0123456789abcdef';
  const child = spawn(process.execPath, [entry], { env: { ...process.env, MOTION_STUDIO_PORT: String(port), MOTION_STUDIO_TOKEN: token }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForReady(child);
    const origin = 'http://127.0.0.1:' + port;
    const health = await fetch(origin + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'motion-studio-local-runtime' });
    const rejected = await fetch(origin + '/api/validate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' }, body: '{}' });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(origin + '/api/validate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ project: {} }) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).valid, false);
    const tooLarge = await fetch(origin + '/api/validate', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ project: 'x'.repeat(2 * 1024 * 1024 + 1) }) });
    assert.equal(tooLarge.status, 400);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
  }
});

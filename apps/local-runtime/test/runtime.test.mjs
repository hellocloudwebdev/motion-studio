import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local runtime refuses to start without explicit auth token', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "if (!process.env.MOTION_STUDIO_TOKEN) process.exit(2)"], { env: { ...process.env, MOTION_STUDIO_TOKEN: '' } });
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
});

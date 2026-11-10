import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cli = path.resolve('apps/cli/src/index.mjs');

test('creative planning CLI fails safely when its local OpenRouter key is not configured', () => {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const result = spawnSync(process.execPath, [cli, 'plan', 'Create a short explainer'], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENROUTER_API_KEY is required/);
  assert.doesNotMatch(result.stderr, /sk-or-v1-/);
});

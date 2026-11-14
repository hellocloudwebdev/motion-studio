import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Adobe MCP launcher never enables arbitrary code execution', async () => {
  const source = await readFile(new URL('./adobe-mcp-launcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /delete env\.AE_MCP_ENABLE_EVAL/);
  assert.match(source, /PREMIERE_MCP_CAPABILITIES.*inspect/);
  assert.doesNotMatch(source, /PREMIERE_MCP_CAPABILITIES.*unsafe-script/);
});

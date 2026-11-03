import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('render manager process execution never uses shell interpolation', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('motion-render-ok')"], { shell: false, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => output += text);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0);
  assert.equal(output, 'motion-render-ok');
});

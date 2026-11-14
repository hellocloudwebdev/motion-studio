#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const app = process.argv[2];
if (!['aftereffects', 'premiere'].includes(app)) throw new Error('Usage: adobe-mcp-launcher.mjs aftereffects|premiere');
const configRoot = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming' : '.config');
const secretPath = path.join(configRoot, 'motion-studio', 'secrets', 'premiere-uxp-token');
const env = { ...process.env };
let entry;
if (app === 'aftereffects') {
  entry = require.resolve('@kumoproductions/mcp-aftereffects');
  env.AE_MCP_READONLY = env.MOTION_STUDIO_ADOBE_EDIT === '1' ? '0' : '1';
  delete env.AE_MCP_ENABLE_EVAL;
} else {
  entry = require.resolve('premiere-pro-mcp');
  env.PREMIERE_MCP_CAPABILITIES = env.MOTION_STUDIO_ADOBE_EDIT === '1' ? 'inspect,edit,export,filesystem' : 'inspect';
  env.PREMIERE_MCP_TOOL_PACKS = 'inspection';
  try {
    const token = (await readFile(secretPath, 'utf8')).trim();
    if (token) env.PREMIERE_UXP_TOKEN = token;
  } catch {}
}
delete env.MOTION_STUDIO_ADOBE_EDIT;
const child = spawn(process.execPath, [entry], { env, stdio: 'inherit', shell: false });
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });

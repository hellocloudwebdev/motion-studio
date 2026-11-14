#!/usr/bin/env node
// FilmCraft / EffectCraft MCP launcher. Bridges the harness MCP configs to
// the craft CLIs' headless MCP servers over stdio:
//   effectcraft → `effectcraft-cli mcp`
//   filmcraft   → `filmcraft-cli -- mcp`
// Fixed argv, no shell, no arbitrary code execution surface.
import { spawn } from 'node:child_process';
import { craftCommandCandidates, craftMcpArgs } from '../packages/craft-mcp-client/src/index.mjs';
import { access } from 'node:fs/promises';

const app = process.argv[2];
if (!['effectcraft', 'filmcraft'].includes(app)) throw new Error('Usage: craft-mcp-launcher.mjs effectcraft|filmcraft');

const env = { ...process.env };
delete env.MOTION_STUDIO_CRAFT_EDIT;
let command = null;
for (const candidate of craftCommandCandidates({ app, env })) {
  try { await access(candidate); command = candidate; break; } catch {}
}
if (!command) command = craftCommandCandidates({ app, env })[1] ?? app + '-cli';
const child = spawn(command, craftMcpArgs(app), { env, stdio: 'inherit', shell: false });
child.once('error', error => { process.stderr.write('The ' + app + ' CLI could not be launched: ' + error.message + '\nInstall it from https://github.com/storytold/' + app + ' (releases or getartcraft.com), or point ' + (app === 'filmcraft' ? 'FILMCRAFT_CLI' : 'EFFECTCRAFT_CLI') + ' at the binary.\n'); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });

#!/usr/bin/env node
// Motion Studio craft MCP servers launcher (first-party, feature-rich):
//   effectcraft → packages/effectcraft-mcp-server (stdio)
//   filmcraft   → packages/filmcraft-mcp-server (stdio)
// These complement the pass-through servers from `craft-mcp-launcher.mjs`,
// which expose the craft CLIs' own built-in MCP surfaces unchanged. The
// studio servers wrap the same CLIs with Motion Studio conventions:
// zod-validated tool schemas, approval-gated mutations, independent FFprobe
// verification receipts, engine scene planning/rendering and an optional
// `--http` mode for the Adobe UXP panels (see uxp/README.md).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const app = process.argv[2];
if (!['effectcraft', 'filmcraft'].includes(app)) throw new Error('Usage: craft-studio-mcp-launcher.mjs effectcraft|filmcraft');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages', app + '-mcp-server', 'src', 'index.mjs');
await import(pathToFileURL(entry).href);

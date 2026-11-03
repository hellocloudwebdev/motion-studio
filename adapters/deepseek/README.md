# DeepSeek-compatible harness integration

Use Motion Studio's generic MCP transport when the harness supports local stdio MCP servers.

- Command: `node`
- Argument: absolute path to the managed install's `scripts/mcp-launcher.mjs`
- Generated config: `adapters/deepseek.mcp.json` under the Motion Studio user config directory.

Import the provider-neutral skill files from `skills/` when the harness supports local skill instructions. No universal DeepSeek plugin manifest is assumed; validate the exact harness configuration format before editing user settings.

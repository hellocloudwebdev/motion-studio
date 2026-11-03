# Z Code integration

Motion Studio is exposed to Z Code through the generic MCP server and provider-neutral skills.

1. Install Motion Studio with `install.ps1` or `./install.sh`.
2. Locate the generated MCP file under the Motion Studio user config directory in `adapters/zcode.mcp.json`.
3. Register its `motion-studio` server in Z Code's MCP settings. The command is Node.js and the argument is the absolute path to `scripts/mcp-launcher.mjs` in the managed install.
4. Add the `skills/` directory as a skill source if the Z Code version supports local skills.
5. Restart Z Code and verify the tools `video.validate_project`, `video.route_scenes` and `video.run_project_qa`.

Z Code configuration formats can change; preserve existing settings and use the generated JSON as the source for manual registration.

# Installation — Motion Studio 0.4 (craft stack)

## Supported platforms

- Windows 10/11, macOS Intel/Apple Silicon, Linux.
- The full pipeline is open source end to end: FilmCraft and EffectCraft ship native builds for Windows, macOS and Linux (plus FreeBSD and a WebAssembly build).
- Node.js 24 or newer is required. The macOS/Linux bootstrap installs a checksum-verified Node 26 LTS user runtime when required. Windows uses WinGet to install current Node LTS when the detected Node is older than 24.

## Install

**Windows PowerShell**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

**macOS / Linux**
```bash
chmod +x install.sh
./install.sh
```

**Non-interactive open-source setup**
```bash
./install.sh --yes
```

The installer stages Motion Studio into a stable per-user directory and installs pinned npm dependencies: HyperFrames, GSAP, Three.js and the Motion Studio craft MCP client. With `--yes`, it installs FFmpeg and Blender through a supported package manager, then prepares HyperFrames' bundled browser.

## Craft tools — free and open source

The specialist/editorial engines are [EffectCraft](https://github.com/storytold/effectcraft) (motion graphics, compositing, effects, expressions, render queue) and [FilmCraft](https://github.com/storytold/filmcraft) (nonlinear editing, color, sound post, export). Both are alpha Rust tools under MIT OR Apache-2.0 with prebuilt installers on their releases pages and getartcraft.com — no account, subscription or activation.

The installer detects the `effectcraft-cli` and `filmcraft-cli` binaries (env overrides `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI`, then PATH, then known per-user install roots) and lists the exact release pages when a tool is missing. Install the alpha build for your platform (or build from source with Rust), then re-run the installer or doctor. See the [installer policy](INSTALLER-CRAFT-POLICY.md).

## MCP services

Motion Studio registers three local stdio servers where the host CLI supports it:

- `motion-studio`: planning, IR, routing, render, QA.
- `effectcraft`: EffectCraft's headless MCP server via `scripts/craft-mcp-launcher.mjs effectcraft` (`effectcraft-cli mcp`).
- `filmcraft`: FilmCraft's headless MCP server via `scripts/craft-mcp-launcher.mjs filmcraft` (`filmcraft-cli -- mcp`).

Both craft tools are alpha: Motion Studio gates every mutation behind an explicit producer approval and independently verifies every render with FFprobe.

Cursor receives a merged `~/.cursor/mcp.json`. Claude Code and Codex use their CLIs when detected. Host-specific JSON is also generated under the Motion Studio user configuration directory for manual import into Z Code and DeepSeek-compatible clients. Restart the host after configuration.

## Verify

```bash
npm test
npm run validate:example
npm run route:example
npm run compile:example
node scripts/doctor.mjs
```

For real craft-tool control, launch the installed CLI (or app with `--control <port>`), and perform the MCP connection check before permitting edits.

## Options

- `--yes`: install supported free/open-source software without prompts.
- `--minimal`: skip OS package installs.
- `--skip-software`: skip FFmpeg/Blender package installation.
- `--skip-hosts`: skip agent skill and MCP host configuration.
- `--dry-run`: display planned actions without modifying the machine.

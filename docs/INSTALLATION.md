# Installation — Motion Studio 0.4 (dual stack)

## Supported platforms

- Windows 10/11, macOS Intel/Apple Silicon, Linux.
- The default pipeline is open source end to end: FilmCraft and EffectCraft ship native builds for Windows, macOS and Linux (plus FreeBSD and a WebAssembly build). The optional licensed Adobe stack supports Windows/macOS only.
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

## Craft tools — free and open source (default engines)

The default specialist/editorial engines are [EffectCraft](https://github.com/storytold/effectcraft) (motion graphics, compositing, effects, expressions, render queue) and [FilmCraft](https://github.com/storytold/filmcraft) (nonlinear editing, color, sound post, export). Both are alpha Rust tools under MIT OR Apache-2.0 with prebuilt installers on their releases pages and getartcraft.com — no account, subscription or activation.

The installer detects the `effectcraft-cli` and `filmcraft-cli` binaries (env overrides `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI`, then PATH, then known per-user install roots) and lists the exact release pages when a tool is missing. Install the alpha build for your platform (or build from source with Rust), then re-run the installer or doctor. See the [installer policy](INSTALLER-CRAFT-POLICY.md).

## Adobe — optional licensed stack (retained)

The licensed Adobe integration is retained alongside the craft stack: hosts with a Creative Cloud subscription can drive After Effects and Premiere Pro through their upstream npm MCP packages (read-only onboarding, exact-operation approvals, no arbitrary scripts). Adobe apps are installed and activated by you through Creative Cloud — Motion Studio never automates login or licensing, and the installer still opens Adobe's official installation page when the apps are missing. Premiere 25.6+ can use the pinned authenticated UXP connector (a local token file the installer generates); older versions use the signed CEP compatibility connector via `--install-premiere-cep`. A production selects the stack with `engineHint` per scene or `MOTION_STUDIO_EDITORIAL_ENGINE=premiere-pro` for assembly.

## MCP services

Motion Studio registers five local stdio servers where the host CLI supports it:

- `motion-studio`: planning, IR, routing, render, QA.
- `effectcraft`: EffectCraft's headless MCP server via `scripts/craft-mcp-launcher.mjs effectcraft` (`effectcraft-cli mcp`).
- `filmcraft`: FilmCraft's headless MCP server via `scripts/craft-mcp-launcher.mjs filmcraft` (`filmcraft-cli -- mcp`).
- `aftereffects`: upstream AE MCP, read-only by default; arbitrary ExtendScript disabled.
- `premiere-pro`: upstream Premiere MCP, inspect-only by default; unsafe-script authority disabled.

The craft tools are alpha: Motion Studio gates every mutation behind an explicit producer approval and independently verifies every render with FFprobe. The Adobe servers keep their read-only/inspect-only onboarding defaults.

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
- `--install-premiere-cep`: install the upstream CEP compatibility connector for the optional licensed Adobe stack (close Premiere first).

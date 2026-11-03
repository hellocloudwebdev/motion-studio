# Installation — Motion Studio 0.3

## Supported platforms

- Windows 10/11, macOS Intel/Apple Silicon.
- Linux for the open-source pipeline. Adobe desktop applications are not supported on Linux.
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

The installer stages Motion Studio into a stable per-user directory and installs pinned npm dependencies: HyperFrames, GSAP, Three.js, the Motion Studio MCP SDK, and the official upstream After Effects and Premiere MCP packages. With `--yes`, it installs FFmpeg and Blender through a supported package manager, then prepares HyperFrames' bundled browser.

## Adobe installation — user account required

The installer detects Creative Cloud, After Effects and Premiere Pro. When Adobe products are missing, it opens Adobe's official Creative Cloud installation page/app and explains the required user action.

The user must sign in, install entitled products and accept Adobe trust prompts. Motion Studio does not automate account login, subscriptions, license entitlements or activation.

After Effects MCP requires Node 24+, After Effects 2024–2026, and the AE preference **Allow Scripts to Write Files and Access Network**. Onboarding starts it read-only. See [Adobe setup policy](INSTALLER-ADOBE-POLICY.md).

Premiere MCP is pinned to the published npm package v1.28.0. Premiere 25.6+ can use its authenticated UXP connector; the installer opens the matching official v1.28.0 CCX download and creates a local token file. The user installs/trusts the CCX in Creative Cloud and copies the token into the panel. Older Premiere versions can use the signed CEP compatibility connector; close Premiere first, then run:
```powershell
.\install.ps1 --install-premiere-cep
```
or
```bash
./install.sh --install-premiere-cep
```

## MCP services

Motion Studio registers three local stdio servers where the host CLI supports it:

- `motion-studio`: planning, IR, routing, render, QA.
- `aftereffects`: upstream AE MCP, read-only by default; arbitrary ExtendScript disabled.
- `premiere-pro`: upstream Premiere MCP, inspect-only by default; unsafe-script authority disabled.

Cursor receives a merged `~/.cursor/mcp.json`. Claude Code and Codex use their CLIs when detected. Host-specific JSON is also generated under the Motion Studio user configuration directory for manual import into Z Code and DeepSeek-compatible clients. Restart the host after configuration.

## Verify

```bash
npm test
npm run validate:example
npm run route:example
npm run compile:example
node scripts/doctor.mjs
```

For real Adobe control, launch each licensed app, open a copied test project, and perform the read-only MCP connection check before permitting edits.

## Options

- `--yes`: install supported free/open-source software without prompts.
- `--minimal`: skip OS package installs.
- `--skip-software`: skip FFmpeg/Blender package installation.
- `--skip-hosts`: skip agent skill and MCP host configuration.
- `--dry-run`: display planned actions without modifying the machine.
- `--install-premiere-cep`: install the upstream CEP compatibility connector (close Premiere first).

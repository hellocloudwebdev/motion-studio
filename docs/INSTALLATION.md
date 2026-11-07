# Installation — Motion Studio 0.4

## Supported platforms

- Windows 10/11, macOS Intel/Apple Silicon.
- Linux for the open-source pipeline. Adobe desktop applications are not supported on Linux.
- Node.js 24 or newer is required. The macOS/Linux bootstrap installs a checksum-verified Node 26 LTS user runtime when required. Windows uses WinGet.

## Install

**Windows PowerShell**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\\install.ps1
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

The installer stages Motion Studio into a per-user directory and installs pinned npm dependencies: HyperFrames, GSAP, Three.js, the Motion Studio MCP SDK, `@kumoproductions/mcp-aftereffects@0.3.2` and `premiere-pro-mcp@1.29.0`. With `--yes`, it installs FFmpeg and prepares HyperFrames' bundled browser. Blender remains optional and can be installed with `--install-blender`.

## Adobe installation — user account required

The installer detects Creative Cloud, After Effects and Premiere Pro. When Adobe products are missing, it opens Adobe's official Creative Cloud installation workflow.

The user must sign in, install entitled products and accept Adobe trust prompts. Motion Studio does not automate account login, subscription purchase, licensing or activation.

After Effects MCP requires Node 24+, After Effects 2024–2026, and the AE preference **Allow Scripts to Write Files and Access Network**. Onboarding starts AE read-only. During an approved Motion Studio workflow, only the scoped `comp,layer,text,transform,keyframe,render` operation categories are enabled; arbitrary ExtendScript eval remains disabled.

The upstream Premiere package is `premiere-pro-mcp@1.29.0`. Its UXP connector is available for UXP-specific workflows on Premiere 25.6+, but Motion Studio 0.4's complete import-and-new-sequence workflow is currently CEP-backed.

Close Premiere Pro and run the upstream CEP connector installer:
```powershell
.\\install.ps1 --install-premiere-cep
```
or
```bash
./install.sh --install-premiere-cep
```

The UXP token, when using the upstream UXP connector for other supported workflows, is stored in a user-only secret file. It is never written to git or project files.

## MCP services

The installer registers three local stdio servers where supported:
- `motion-studio`: IR, routing, HyperFrames rendering, QA and Adobe orchestration.
- `aftereffects`: upstream AE MCP, read-only by default, arbitrary eval disabled.
- `premiere-pro`: upstream Premiere MCP, inspect-only by default, unsafe-script disabled.

Cursor gets a merged `~/.cursor/mcp.json`. Claude Code and Codex are registered through their CLIs when detected. Generic MCP config for Z Code/DeepSeek-compatible hosts is written under the Motion Studio user config directory. Restart the host after configuration.

## Verify

```bash
npm install
npm test
npm run validate:example
npm run route:example
npm run compile:example
node scripts/doctor.mjs
```

For licensed-host validation, launch each Adobe app, open a copy of a saved test project, run read-only preflight and review the preview plan. Mutations require separate explicit approval and a new backup path.

## Installer options

- `--yes`: install free/open-source dependencies using supported package managers.
- `--minimal` / `--skip-software`: skip FFmpeg/Blender package installation.
- `--skip-hosts`: skip agent skill and MCP host configuration.
- `--dry-run`: display planned actions without modifying the machine.
- `--install-premiere-cep`: install the upstream CEP compatibility connector (Premiere must be closed).

## Uninstall Motion Studio

Preview the files Motion Studio will remove:
```bash
node scripts/uninstall.mjs
```

Confirm removal:
```bash
node scripts/uninstall.mjs --yes
```

Or, from the repository, use `npm run uninstall:studio -- --yes`. The uninstaller removes the managed application directory, install record, installer-owned skill/agent files and adapter configs explicitly marked as Motion Studio-managed. It removes only Cursor MCP entries whose launch paths point into the Motion Studio install directory.

It preserves unrelated user configuration, unmarked adapter files and secret/token files. Adobe desktop applications and Creative Cloud are never uninstalled. Claude Code/Codex CLI MCP registrations are left untouched; remove those explicitly with the relevant host CLI if you previously registered them.

# Adobe software and MCP installation policy

## User outcome

When a user downloads Motion Studio and runs the installer, Motion Studio installs its free toolchain and configures the licensed Adobe integrations as far as the OS and Adobe permit. The installer clearly separates software installed automatically from licensed products the user installs through Adobe Creative Cloud.

## Automated actions

- Check OS/architecture and Node 24+.
- Install HyperFrames, GSAP, FFmpeg/FFprobe and pinned Adobe MCP npm packages.
- Detect Creative Cloud Desktop, After Effects and Premiere Pro.
- Install the Premiere CEP connector using the upstream installer when that path is selected.
- Prepare a UXP setup handoff on Premiere 25.6+; install the current release CCX only through Adobe's supported Creative Cloud/UXP flow. Never fake a successful CCX installation.
- Add local stdio MCP configuration for both Adobe apps using exact package versions and local paths.
- Run package doctor and read-only host connection preflight.
- Generate a machine-readable install report with installed/detected/needs-user-action/failed states.

## User-mediated actions

If Creative Cloud or either Adobe product is missing:
1. Open the official Adobe Creative Cloud page.
2. Ask the user to sign in with their own Adobe account.
3. The user selects and installs After Effects and/or Premiere Pro in Creative Cloud.
4. Motion Studio re-checks standard app locations and platform application metadata.
5. Ask the user to launch each app, complete first-run dialogs, and enable the AE scripting preference.
6. For Premiere, the user approves UXP trust prompts and configures a generated bridge token in the server and UXP panel if that connector is selected.

Motion Studio does not automate credentials, subscription purchase, entitlements, account sign-in or activation.

## Upstream MCP package pins

Initial 0.3 compatibility pins are recorded in `configs/software-lock.json`.

- After Effects: `@kumoproductions/mcp-aftereffects` — Node 24+, Windows/macOS, AE 2024–2026. Read-only startup; eval disabled.
- Premiere Pro: `premiere-pro-mcp` — Node 20.19+, Windows/macOS, Premiere 2020–2026. Prefer UXP at 25.6+ where live capabilities allow it; CEP is compatibility path. No unsafe-script authority.

Install only from the official npm packages/repositories. Treat their package scripts/connectors as third-party executable code.

## Security defaults

- Both servers run locally over stdio.
- AE starts read-only until user approves edits to a test/copy project.
- `AE_MCP_ENABLE_EVAL` is never set by the installer.
- Premiere `unsafe-script` authority stays disabled.
- No Adobe credentials/tokens in git, project files or logs.
- Mutating operations require a project checkpoint and post-operation readback.
- A green panel or package doctor is not proof of a completed edit/export.

## Uninstall

Uninstall removes only Motion Studio-owned configuration entries and packages. It must not remove Creative Cloud, After Effects, Premiere Pro, shared Adobe services or user projects. Remove a connector only if Motion Studio installed it, and only after Adobe apps are closed.

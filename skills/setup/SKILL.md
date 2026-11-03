---
name: motion-studio-setup
description: Set up, diagnose or update the Motion Studio local video-production environment and agent integrations.
---

# Motion Studio setup

1. Inspect VERSION, docs/INSTALLATION.md and docs/SOFTWARE-MATRIX.md before changing setup.
2. Run node scripts/doctor.mjs to inspect runtime, media engines and host CLIs.
3. For a fresh machine, use install.ps1 on Windows or ./install.sh on macOS/Linux. Do not bypass OS package-manager prompts or license dialogs.
4. Run npm test after installation or updates.
5. Confirm actual engine availability; never claim a render engine works solely because its package was installed.
6. Keep paid Adobe applications and AI-host sign-in under the user's control.
7. Preserve existing MCP settings and skill files. Back up before modifying user-level configuration.
8. Use generic MCP configuration for hosts without a native adapter.

A successful setup report lists installed software, detected software, host integrations, skipped licensed products and warnings separately.

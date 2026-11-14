---
name: motion-studio-setup
description: Set up, diagnose or update the Motion Studio local video-production environment and agent integrations.
---

# Motion Studio setup

1. Inspect VERSION, docs/INSTALLATION.md and docs/SOFTWARE-MATRIX.md before changing setup.
2. Run node scripts/doctor.mjs to inspect runtime, media engines and host CLIs.
3. For a fresh machine, use install.ps1 on Windows or ./install.sh on macOS/Linux. Do not bypass OS package-manager prompts.
4. Run npm test after installation or updates.
5. Confirm actual engine availability; never claim a render engine works solely because its package was installed.
6. Keep AI-host sign-in and credential storage under the user's control; the craft tools (FilmCraft/EffectCraft) are free open-source installs.
7. Preserve existing MCP settings and skill files. Back up before modifying user-level configuration.
8. Use generic MCP configuration for hosts without a native adapter.

A successful setup report lists installed software, detected craft tools (FilmCraft/EffectCraft), host integrations, skipped optional products and warnings separately.

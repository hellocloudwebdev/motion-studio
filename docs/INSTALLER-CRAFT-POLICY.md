# FilmCraft / EffectCraft installation policy (architecture pivot 2026-11-14)

## User outcome

When a user downloads Motion Studio and runs the installer, Motion Studio installs its free toolchain, detects the free open-source craft tools (FilmCraft, EffectCraft) and registers their headless MCP servers for the supported hosts. There is no account, subscription or activation step: both tools ship prebuilt installers on their GitHub releases pages and getartcraft.com.

## Automated actions

- Check OS/architecture and Node 24+.
- Install HyperFrames, GSAP and FFmpeg/FFprobe through OS package managers.
- Detect the `effectcraft-cli` and `filmcraft-cli` binaries (env override `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI`, then PATH, then known per-user install roots).
- Register local stdio MCP servers through `scripts/craft-mcp-launcher.mjs` for every supported host (Cursor/Claude/Codex/ZCode/DeepSeek adapter configs).
- Run package doctor and connection preflight.
- Generate a machine-readable install report with installed/detected/needs-user-action/failed states; a failing run writes a failure record with an idempotent-recovery hint.

## User-mediated actions

If either craft CLI is missing:
1. The installer lists the exact release pages (github.com/storytold/effectcraft, github.com/storytold/filmcraft).
2. The user installs the alpha build for their platform (Windows MSI/portable, macOS DMG, Linux AppImage/deb/rpm/tarball) — or builds from source with Rust.
3. Motion Studio re-probes the CLI candidates on the next run (or the user sets the env overrides for portable installs).

Motion Studio does not remove, upgrade or downgrade user-installed craft tools on its own.

## Tool pins

Initial craft compatibility entries are recorded in `configs/software-lock.json`:

- EffectCraft: alpha, all platforms, motion graphics/VFX — headless MCP via `effectcraft-cli mcp`.
- FilmCraft: alpha, all platforms, editorial assembly/color/sound/export — headless MCP via `filmcraft-cli -- mcp`.

Both are clean-room Rust implementations (MIT OR Apache-2.0). Install only from their official releases; alpha status means Motion Studio independently verifies every render with FFprobe and never trusts receipt metadata alone.

## Security defaults

- Both MCP servers run locally over stdio; no public network listener.
- Every mutating operation requires a time-bounded, project/run/tool/argument-scoped producer approval (`@motion-studio/craft-mcp-client`).
- No credentials or tokens are needed or stored for the craft tools.
- Mutating operations require a project checkpoint and post-operation readback.
- A green panel or package doctor is not proof of a completed edit/export.

## Uninstall

Uninstall removes only Motion Studio-owned configuration entries and packages. It must not remove FilmCraft, EffectCraft or user projects; removing the craft apps themselves is a normal per-platform uninstall performed by the user.

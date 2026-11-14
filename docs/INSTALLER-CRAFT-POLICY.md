# Installation policy — craft tools (default) and licensed Adobe (retained, dual stack)

## User outcome

When a user downloads Motion Studio and runs the installer, Motion Studio installs its free toolchain, detects the free open-source craft tools (FilmCraft, EffectCraft) and registers their headless MCP servers for the supported hosts. There is no account, subscription or activation step for the craft tools: both ship prebuilt installers on their GitHub releases pages and getartcraft.com.

The licensed Adobe integration is RETAINED as an optional stack for subscribed hosts — the installer still detects Creative Cloud/After Effects/Premiere Pro, still opens Adobe's official installation flow when they are missing, and still supports the pinned Premiere UXP/CEP connectors. A production picks a stack per scene (`engineHint`) or globally (`MOTION_STUDIO_EDITORIAL_ENGINE=premiere-pro`); the free craft stack remains the default.

## Automated actions

- Check OS/architecture and Node 24+.
- Install HyperFrames, GSAP and FFmpeg/FFprobe through OS package managers; install the pinned Adobe MCP npm packages (they ship in the dependency tree).
- Detect the `effectcraft-cli` and `filmcraft-cli` binaries (env override `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI`, then PATH, then known per-user install roots) AND Creative Cloud/After Effects/Premiere Pro.
- Register local stdio MCP servers for every supported host (Cursor/Claude/Codex/ZCode/DeepSeek adapter configs): craft launchers + Adobe launchers.
- On Premiere 25.6+ (licensed stack), prepare the UXP setup handoff; on older versions, install the CEP connector only when `--install-premiere-cep` is selected.
- Run package doctor and connection preflight.
- Generate a machine-readable install report with installed/detected/needs-user-action/failed states for BOTH stacks; a failing run writes a failure record with an idempotent-recovery hint.

## User-mediated actions

If either craft CLI is missing:
1. The installer lists the exact release pages (github.com/storytold/effectcraft, github.com/storytold/filmcraft).
2. The user installs the alpha build for their platform (Windows MSI/portable, macOS DMG, Linux AppImage/deb/rpm/tarball) — or builds from source with Rust.
3. Motion Studio re-probes the CLI candidates on the next run (or the user sets the env overrides for portable installs).

If Adobe products are missing (optional licensed stack):
1. The installer opens Adobe's official Creative Cloud page and lists the required user actions.
2. The user signs in, installs entitled products and accepts Adobe trust prompts; Motion Studio never automates login, subscription, entitlement or activation.

Motion Studio does not remove, upgrade or downgrade user-installed craft tools or Adobe apps on its own.

## Tool pins

Compatibility entries are recorded in `configs/software-lock.json`:

- EffectCraft: alpha, all platforms, motion graphics/VFX — headless MCP via `effectcraft-cli mcp` (free default specialist engine).
- FilmCraft: alpha, all platforms, editorial assembly/color/sound/export — headless MCP via `filmcraft-cli -- mcp` (free default editorial engine).
- Adobe (licensed optional): AE 2024–2026 via `@kumoproductions/mcp-aftereffects` (read-only startup, eval disabled); Premiere 2020–2026 via `premiere-pro-mcp` (UXP at 25.6+, CEP compatibility path, no unsafe-script authority).

The craft tools are clean-room Rust implementations (MIT OR Apache-2.0). Install only from their official releases; alpha status means Motion Studio independently verifies every render with FFprobe and never trusts receipt metadata alone.

## Security defaults

- All MCP servers run locally over stdio; no public network listener.
- Every mutating operation requires a time-bounded, project/run/tool/argument-scoped producer approval (craft client and Adobe client alike).
- No credentials or tokens are needed or stored for the craft tools; the Premiere UXP token (licensed stack) stays in a user-only secret file.
- Mutating operations require a project checkpoint and post-operation readback.
- A green panel or package doctor is not proof of a completed edit/export.

## Uninstall

Uninstall removes only Motion Studio-owned configuration entries and packages. It must not remove FilmCraft, EffectCraft, Creative Cloud, After Effects, Premiere Pro, shared Adobe services or user projects; removing applications is a normal per-platform uninstall performed by the user.

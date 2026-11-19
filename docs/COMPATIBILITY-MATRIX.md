# Compatibility matrix — hosts, engines and craft tools (P4.2)

Motion Studio does not assume similar host behavior across AI harnesses or machines. The matrix is **evidence-based**: `scripts/compatibility-matrix.mjs` renders a machine-readable JSON matrix for the current host from live probes (software detection, CLI presence, MCP command surface), and `scripts/doctor.mjs` verifies the same engines more deeply. This document records the verified combinations; every row must carry evidence from an actual run, never an assumption.

## How to render your host's row

```bash
node scripts/compatibility-matrix.mjs > compatibility-$(node -p "process.platform").json
node scripts/doctor.mjs > doctor-$(node -p "process.platform").json
```

The matrix JSON contains one `engines.*` entry per engine with `available`, `path` and `version`. Engine probes inherit the calling shell's PATH — render the matrix from the environment you actually work in.

## Verified combinations (evidence log)

| Date | Host | Motion Studio | EffectCraft | FilmCraft | FFmpeg/FFprobe | Blender | HyperFrames browser | Evidence |
|---|---|---|---|---|---|---|---|---|
| 2026-11-15 | Windows x64 (producer workstation) | 1.0.0-alpha.1 | 0.24.1 | 0.20.1 | 9.0.2 (winget Gyan.FFmpeg) | 5.3.0 (winget) | prepared (headless shell) | craft MCP round-trips, EffectCraft comp render, FilmCraft handoff + export — all FFprobe-verified |
| 2026-11-17 | Same host | 1.0.0-alpha.1 | 0.24.1 | 0.20.1 | 9.0.2 | 5.3.0 | prepared | asset layers, editorial trims, effects wiring — FFprobe-verified |
| 2026-11-19 | Same host | 1.0.0-alpha.1 | 0.24.1 | 0.20.1 | 9.0.2 | 5.3.0 | prepared | expressions + checkpoints live-verified; 3D rotating-cube render verified |

## CI coverage (ubuntu-latest / windows-latest / macos-latest, Node 24)

- npm install from lockfile, full test suite, dependency audit (non-blocking).
- Per-OS FFmpeg installs keep the media-fixture tests in the signal.
- Deliberately NOT in CI (runtime-gated on developer hosts): Blender rendering, EffectCraft/FilmCraft CLI rendering, HyperFrames headless browser, licensed Adobe integrations. See [CI scope](CI.md).

## Licensed Adobe stack (optional, retained)

After Effects 2024–2026 and Premiere Pro 2020–2026 remain supported through their upstream MCP packages on Windows/macOS with a Creative Cloud subscription. No live Adobe workstation round-trip has been recorded yet — that acceptance gate stays open until one is.

## Craft tool notes

- EffectCraft and FilmCraft ship prebuilt installers (Windows MSI/portable, macOS DMG, Linux AppImage/deb/rpm/tarball) and install per-user by default — the compatibility probe enumerates every Windows profile directory so an install under a different user's profile still resolves.
- `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI` environment overrides take precedence for portable installs.
- Both tools are alpha: Motion Studio independently verifies every render with FFprobe and gates mutations behind explicit producer approval.

See the [software matrix](SOFTWARE-MATRIX.md), the [installer policy](INSTALLER-CRAFT-POLICY.md) and [software lock](../configs/software-lock.json).

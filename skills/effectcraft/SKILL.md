---
name: effectcraft
description: Plan and produce specialist EffectCraft motion graphics, compositing, effects and expressions scenes.
---
# EffectCraft production

- Use EffectCraft for complex motion graphics, compositing, effects (308 built-in), JavaScript expressions and 3D cameras/lights inside compositions.
- Treat the Canonical Video IR as source of truth; `.ecproj` files are derived production artifacts (versioned JSON).
- Drive it headless through `effectcraft-cli` (one-shot commands, render queue, `mcp` MCP server) or the running app's `--control` JSON channel; UI-only commands need the app or an MCP bridge.
- Every mutation requires explicit producer approval (the craft approval gate); alpha tool — verify renders, never trust receipt metadata alone.
- Render scene comps via `effectcraft-cli render --comp <name> --out <file>` to an explicit output contract; record frame rate, dimensions, color space, alpha and duration.
- Export Lottie (`file.exportLottie`) when a web-native preview of the comp is useful.
- Inspect rendered output before passing it to FilmCraft editorial assembly.
- Two MCP servers exist: `effectcraft` (pass-through of the CLI's own headless MCP surface) and `effectcraft-studio` (Motion Studio's first-party server: `effectcraft.check_engine`, `effectcraft.list_commands`, `effectcraft.describe_command`, `effectcraft.inspect_project`, `effectcraft.plan_scene`, `effectcraft.render_frame`, plus approval-gated `effectcraft.run_command`, `effectcraft.run_batch` and verified `effectcraft.render_scene` / `effectcraft.render_comp`). Prefer the studio server for production work: it validates arguments, enforces the approval gate and returns FFprobe/sha256 verification receipts (`isError` when unverified).
- Operators inside After Effects can use the Motion Studio UXP panel (`uxp/effectcraft-panel`, loaded via UXP Developer Tool) which talks to the studio server in `--http` mode on `http://127.0.0.1:7420/mcp`.

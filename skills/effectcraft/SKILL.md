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
- Two MCP servers exist: `effectcraft` (pass-through of the CLI's own headless MCP surface) and `effectcraft-studio` (Motion Studio's first-party server, 23 tools). Beyond raw engine commands it offers: compositing ops (`add_mask`, `set_track_matte`, `set_blend_mode`, `set_parent`, `add_marker`, `set_work_area`), interchange (`import_timeline`/`export_timeline` for FCPXML/FCP7 XML/OTIO/EDL), web delivery (`export_lottie`, `render_queue` for multi-comp verified renders), `list_fonts`, `plan_scene`, `run_command`/`run_batch` and verified artifacts (`render_scene`, `render_comp`, `render_frame`). The engine's JavaScript `script` surface is deliberately not exposed (`allowArbitraryScript: false`). Prefer the studio server for production work: it validates arguments, enforces the approval gate and returns FFprobe/sha256 verification receipts (`isError` when unverified).
- Operators inside After Effects can use the Motion Studio UXP panel (`uxp/effectcraft-panel`, loaded via UXP Developer Tool) which talks to the studio server in `--http` mode on `http://127.0.0.1:7420/mcp`.

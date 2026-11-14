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

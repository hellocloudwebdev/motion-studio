---
name: filmcraft
description: Assemble rendered scenes, footage, audio and captions into a final editorial timeline in FilmCraft.
---
# FilmCraft editorial assembly

- Use FilmCraft for timeline editing, pacing, track management, color grading, captions and audio assembly.
- Build `.fcproj` sequences from verified scene outputs and their output contracts; interchange in via FCPXML, FCP7 XML, OpenTimelineIO, EDL, AAF or OMF (Motion Studio exports FCPXML through the editorial-interchange package).
- Do not use FilmCraft as the default renderer for individual motion-graphics layers.
- Keep scene order and frame timing aligned to Canonical Video IR.
- Drive it headless through `filmcraft-cli` (engine commands, `-- mcp` MCP server) or the JSON-lines control channel (`--control <port>`); every mutation requires explicit producer approval (alpha tool).
- Export through the CLI render/export commands and independently inspect the final export before delivery sign-off.

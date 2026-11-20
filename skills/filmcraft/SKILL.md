---
name: filmcraft
description: Assemble rendered scenes, footage, audio and captions into a final editorial timeline in FilmCraft.
---
# FilmCraft editorial assembly

- Use FilmCraft for timeline editing, pacing, track management, color grading, captions and audio assembly.
- Build `.fcproj` sequences from verified scene outputs and their output contracts; interchange in via FCPXML, FCP7 XML, OpenTimelineIO, EDL, AAF or OMF (Motion Studio exports FCPXML through the editorial-interchange package).
- Do not use FilmCraft as the default renderer for individual motion-graphics layers.
- Keep scene order and frame timing aligned to Canonical Video IR.
- Drive it headless through `filmcraft-cli` (engine commands, `mcp` MCP server) or the JSON-lines control channel (`--control <port>`); every mutation requires explicit producer approval (alpha tool).
- Export through the CLI render/export commands and independently inspect the final export before delivery sign-off.
- Two MCP servers exist: `filmcraft` (pass-through of the CLI's own headless MCP surface) and `filmcraft-studio` (Motion Studio's first-party server, 27 tools). Beyond raw engine commands it offers: captions (`add_captions`/`import_captions`/`export_captions`), audio post (`inspect_mixer`, `set_clip_audio_gain`, `auto_match_loudness`, `generate_ducking`), narration (`list_tts_voices`, `create_tts_narration`, `download_tts_voices` — the voice package is an explicit approval-gated download), editorial (`add_markers`, `detect_scene_cuts`, `speed_clip`), plus `import_interchange`, `apply_transition`, `run_command`/`run_batch` and verified artifacts (`export_master`, `export_frame`). Prefer the studio server for production work: it validates arguments, enforces the approval gate, refuses offline media and returns FFprobe/sha256 verification receipts (`isError` when unverified).
- Operators inside Premiere Pro can use the Motion Studio UXP panel (`uxp/filmcraft-panel`, loaded via UXP Developer Tool) which talks to the studio server in `--http` mode on `http://127.0.0.1:7430/mcp`.

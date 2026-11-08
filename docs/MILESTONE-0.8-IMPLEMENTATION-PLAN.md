# Motion Studio 0.8 — Media derivatives and preview artifacts

## Objective
Turn indexed source media into bounded, reproducible preview artifacts that make asset review and editorial preparation faster without changing or replacing source files.

## Scope
- [x] New `@motion-studio/media-derivatives` workspace package.
- [x] FFprobe stream discovery and source SHA-256 provenance.
- [x] Video proxy MP4 generation (H.264/AAC, capped 1280px width, fast-start).
- [x] Representative video thumbnail extraction.
- [x] Audio waveform PNG generation.
- [x] Raster-image preview JPEG generation.
- [x] CLI and local MCP entry points.
- [x] Derivative manifest with source identity, MIME type, byte size and SHA-256 for every output.
- [x] Safe argument-array process invocation, bounded time/output, symlink checks and no-overwrite default.
- [x] Tests and operator documentation.

## Commands
```bash
motion-studio media derive ./media/clip.mp4 --output-dir ./media/derived
motion-studio media derive ./media/music.wav --output-dir ./media/derived --profile preview
motion-studio media derive ./media/still.png --output-dir ./media/derived
```

Profiles: `all` (default) creates a video proxy and thumbnail, audio waveform, or image preview; `proxy` creates only the video proxy; `preview` creates thumbnail/waveform/image preview without a video proxy. Existing outputs are never overwritten unless `--overwrite` is explicit.

## Safety and reproducibility
- The source file is opened read-only and its SHA-256 is recorded before processing.
- FFmpeg and FFprobe are invoked with argument arrays and `shell: false`.
- Source symlinks and output-directory symlinks are rejected.
- Output names include a source-content digest prefix to avoid basename collisions.
- Every derivative is hashed and measured after FFmpeg completes.
- A failed command or empty output does not produce a successful manifest.
- Derivatives are previews, not delivery masters; no automatic source deletion or replacement occurs.

## Deferred
- Cloud storage and distributed derivative caching.
- GPU encoding and adaptive hardware profiles.
- Proxy relinking inside live Premiere/After Effects projects.
- Contact sheets, waveform timelines and browser playback UI.
- Automatic transcoding of 3D, layered design or document formats.

## Acceptance
- All supported media classes generate the expected preview artifacts.
- The source bytes remain unchanged.
- Repeat generation fails safely unless overwrite is explicitly enabled.
- Cross-platform CI passes on Node 24 and 26 across Ubuntu, Windows and macOS.

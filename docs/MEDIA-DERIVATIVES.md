# Media derivatives

Motion Studio can create local editorial previews from indexed media. These files are derivative artifacts: they never replace the original source.

## Generate previews

```bash
motion-studio media derive ./media/clip.mp4 --output-dir ./media/derived
motion-studio media derive ./media/music.wav --output-dir ./media/derived
motion-studio media derive ./media/still.png --output-dir ./media/derived
```

Video inputs produce an H.264/AAC MP4 proxy (up to 1280px wide) and a representative JPEG thumbnail. Audio inputs produce a PNG waveform. Raster images produce a bounded JPEG preview. Use `--profile proxy` for a video proxy only, or `--profile preview` to omit the video proxy. Set `--at-seconds` to choose the thumbnail seek point. Pass `--overwrite` only when replacing prior derivative files is intended.

The JSON manifest records the absolute source path, source SHA-256, source MIME type and byte size, profile, plus each output's kind, MIME type, byte size, path and SHA-256. The digest in output names prevents collisions between same-named sources with different bytes.

## Operational boundaries

- FFmpeg and FFprobe must be installed and available, or their executable paths can be supplied.
- Commands use argument arrays with shell execution disabled.
- Source symlinks and output directory symlinks are rejected.
- Existing outputs are not overwritten by default.
- A derivative is not a delivery master and does not imply rights clearance.
- The process does not alter source media or automatically relink Adobe projects.

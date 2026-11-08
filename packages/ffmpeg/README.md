# FFmpeg / FFprobe package

This package builds and executes media operations through fixed executable allowlists and argument arrays. It never invokes a shell or treats an exit code alone as proof of a valid output.

- `buildTranscodePlan` and `buildFinalizationPlan`: construct bounded scale/FPS, encoding, audio mix, and optional subtitle burn-in operations.
- `runMediaCommand`: spawn only `ffmpeg` or `ffprobe` with `shell: false`.
- `probeMedia` / `inspectMedia`: independently inspect streams and compare the output with a delivery contract.
- `finalizeMedia`: execute, probe and return a verified receipt; it throws when the output contract fails.
- `renderCaptions`: convert integer-frame cues to SRT or WebVTT.

Narration generation, transcript alignment and creative audio review remain provider/workflow work outside this package.

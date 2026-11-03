# FFmpeg package

This package builds validated FFmpeg/FFprobe argument plans. It does not spawn a renderer or claim an output exists. Execution belongs to a future allowlisted render worker that records exit status and verifies artifacts.

- `buildTranscodePlan`: validate paths and output settings, then return an executable plus argument array.
- `buildProbePlan`: create an FFprobe JSON inspection plan.
- `parseProbeOutput`: normalize video/audio stream metadata.

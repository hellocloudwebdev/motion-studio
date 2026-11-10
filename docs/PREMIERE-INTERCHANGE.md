# Premiere interchange

The `@motion-studio/premiere-interchange` package exports a validated editorial assembly manifest to FCPXML 1.10 and a JSON provenance sidecar.

## CLI

```bash
motion-studio editorial plan project.json --output assembly.json
motion-studio premiere export assembly.json --asset-root ./media --output sequence.fcpxml --manifest premiere-handoff.json
```

Absolute local `file:` URIs are accepted directly. Relative source paths require an explicit absolute `--asset-root`; resolved paths must remain within that root. Remote URLs and unsupported schemes fail closed. The exporter verifies SHA-256 against the source file and uses rational frame arithmetic for sequence offsets, source in-points and durations.

The sidecar records project/sequence data, clip IDs, source checksums, resolved URIs, track IDs, frame ranges and producer rights-review state. Non-media layers are reported as unsupported warnings and retained in the sidecar rather than silently converted to visual elements.

## Premiere import

1. Generate and validate the editorial assembly JSON.
2. Export the FCPXML and sidecar to a local folder.
3. In Premiere Pro, use its supported FCPXML import workflow for the installed version.
4. Inspect sequence frame rate, media relinking, track placement, audio routing and all unsupported warnings before editing or delivery.

FCPXML import behavior can vary by Premiere version. The exporter does not launch Premiere, import a sequence, modify an existing project, relink proxies or certify the imported timeline. Always review the imported sequence on a licensed Adobe workstation.

Rights metadata is an audit assertion from the producer, not legal clearance. This export writes interchange files only and never modifies source media.
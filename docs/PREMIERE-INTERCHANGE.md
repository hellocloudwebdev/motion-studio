# Premiere interchange

The `@motion-studio/premiere-interchange` package exports a validated editorial assembly manifest to FCPXML 1.10 and a JSON provenance sidecar.

## CLI

```bash
motion-studio editorial plan project.json --output assembly.json
motion-studio premiere export assembly.json --asset-root ./media --output sequence.fcpxml --manifest premiere-handoff.json
```

Absolute local `file:` URIs are accepted directly. Relative source paths require an explicit absolute `--asset-root`; resolved paths must remain within that root. Remote URLs and unsupported schemes fail closed. The exporter verifies SHA-256 against the source file and uses rational frame arithmetic for sequence offsets, source in-points and durations.

The sidecar records project/sequence data, clip IDs, source checksums, resolved URIs, track IDs, frame ranges and producer rights-review state. Non-media layers are not represented in FCPXML. Export fails closed if any are present; `--allow-unsupported` (or MCP `allowUnsupportedClips: true`) explicitly permits an incomplete interchange and preserves those items in the sidecar with warnings.

## Premiere import

No Premiere Pro release is currently certified by a live import/readback receipt. Treat FCPXML 1.10 export as an interchange file-generation capability, not a supported-version promise. Record the Premiere product/build, import result, sequence settings and readback comparison for each workstation version before adding it to the compatibility matrix.

1. Generate and validate the editorial assembly JSON.
2. Export the FCPXML and sidecar to a local folder.
3. In Premiere Pro, use its supported FCPXML import workflow for the installed version.
4. Inspect sequence frame rate, media relinking, track placement, audio routing and all unsupported warnings before editing or delivery.

For round-trip acceptance, compare the imported sequence's frame rate, duration, clip IDs/names, source in-points, offsets, durations and track lanes against `premiere-handoff.json`. Record any importer normalization separately; do not silently adjust the Canonical Video IR or interchange sidecar to match it.

FCPXML import behavior can vary by Premiere version. The exporter does not launch Premiere, import a sequence, modify an existing project, relink proxies or certify the imported timeline. Always review the imported sequence on a licensed Adobe workstation.

Rights metadata is an audit assertion from the producer, not legal clearance. This export writes interchange files only and never modifies source media.

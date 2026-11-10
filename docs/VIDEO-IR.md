# Canonical Video Project IR

The Canonical Video IR is the versioned, engine-independent source of truth for a production. Renderer-specific projects are derived artifacts.

## Core sections
- `schemaVersion`: IR schema version.
- `project`: ID, objective, frame rate, canvas, duration, color space and revision.
- `creative`: concept, audience and message.
- `brand`: identity tokens, colors, fonts and logo constraints.
- `assets`: media, fonts, audio, provenance and license metadata. Indexed records may include `id`, `kind`, `uri`, `mimeType`, `sha256`, `byteSize` and `metadata` with source, creator, tags and rights-review status. SHA-256 identifies exact bytes; it is not a trust or license assertion.
- Layer `assetId` values should reference an attached asset. Unresolved references are warnings while placeholder workflows are in use; duplicate asset IDs and malformed checksums are validation errors.
- `scenes`: intent, integer frame duration and composable layers.
- `delivery`: output profiles and codec/color/alpha requirements.
- `qa`: defects, repair history and approvals.

## Timing
Store timing as integer frames. Represent frame rate as a rational numerator/denominator pair. Avoid floating-point seconds as the canonical timing unit.

Scenes may declare `startFrame` for intentional gaps or overlaps. A layer's `startFrame` and `durationFrames` are relative to its containing scene; audio cue offsets are relative to the project or containing scene. Convert to seconds only at an engine boundary.

## Scene layers
A scene may contain text, shapes, images, video, 3D, camera, effects, audio, charts, particles and composite layers. Each layer may specify an engine hint and required capabilities.

Project-level `audio.tracks` and scene-level `audioCues` reference declared assets with `kind: "audio"`. Cues may set `offsetFrames` (or `startFrame` for scene cues), `durationFrames` and a gain multiplier from 0 to 4. Delivery profiles may set `audioRequired` to require an audio stream at final inspection.

## Engine-neutral output contract
Rendered scene artifacts must declare dimensions, frame rate, duration frames, color space, alpha support, codec/container and audio metadata. Never mark a render complete without a verified artifact.

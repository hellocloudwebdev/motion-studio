# Canonical Video Project IR

The Canonical Video IR is the versioned, engine-independent source of truth for a production. Renderer-specific projects are derived artifacts.

## Core sections
- `schemaVersion`: IR schema version.
- `project`: ID, objective, frame rate, canvas, duration, color space and revision.
- `creative`: concept, audience and message.
- `brand`: identity tokens, colors, fonts and logo constraints.
- `assets`: media, fonts, audio, provenance and license metadata.
- `scenes`: intent, integer frame duration and composable layers.
- `delivery`: output profiles and codec/color/alpha requirements.
- `qa`: defects, repair history and approvals.

## Timing
Store timing as integer frames. Represent frame rate as a rational numerator/denominator pair. Avoid floating-point seconds as the canonical timing unit.

## Scene layers
A scene may contain text, shapes, images, video, 3D, camera, effects, audio, charts, particles and composite layers. Each layer may specify an engine hint and required capabilities.

## Engine-neutral output contract
Rendered scene artifacts must declare dimensions, frame rate, duration frames, color space, alpha support, codec/container and audio metadata. Never mark a render complete without a verified artifact.

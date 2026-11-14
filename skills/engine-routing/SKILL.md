---
name: engine-routing
description: Route scene layers to the best available renderer based on capability and output contract.
---
# Engine routing

1. Read the scene layers and required capabilities from Canonical Video IR.
2. Route kinetic typography, 2D graphics and data visuals to HyperFrames + GSAP.
3. Route complex compositing, tracking, effects and motion-graphics VFX to EffectCraft (free default) — or to After Effects on licensed Adobe hosts when the layer carries `engineHint: 'after-effects'`.
4. Route simulation, product visualization and 3D scenes to Blender.
5. Route WebGL shaders and interactive procedural 3D to Three.js.
6. Use FilmCraft for editorial assembly (default) or Premiere Pro on licensed hosts (`MOTION_STUDIO_EDITORIAL_ENGINE=premiere-pro`); FFmpeg handles media processing and delivery.
7. Verify engine availability. Never silently substitute an unavailable required engine.
8. Record the selected engine, reason, dependencies and output contract for every task.

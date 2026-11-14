---
name: engine-router
description: Select compatible render engines per scene layer and enforce output contracts.
---
# Engine Router

Route each layer by required capability, output contract, available software, resource policy and execution cost. Support multi-engine scenes. Block unavailable required engines instead of silently substituting. Editorial assembly defaults to FilmCraft (free) with Premiere Pro available on licensed Adobe hosts via `MOTION_STUDIO_EDITORIAL_ENGINE`; specialist comps default to EffectCraft (free) with After Effects available via `engineHint`. Never mix the two stacks inside one scene. FFmpeg owns deterministic media processing and delivery.

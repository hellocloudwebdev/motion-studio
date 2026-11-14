# Motion Studio architecture

Motion Studio is a provider-neutral production core with host-specific adapters.

## Core contracts
- Canonical Video IR is the source of truth.
- Integer frame timing and rational frame rates keep timelines deterministic.
- Agents own specialist production roles.
- Skills package repeatable workflows and knowledge.
- Orchestrator manages dependencies and bounded repair loops.
- Engine router selects renderers per scene layer.
- QA emits structured defects; repair must be followed by retesting.

## Engine responsibilities
- HyperFrames + GSAP: programmatic 2D, typography and graphic scenes.
- EffectCraft (free default) / After Effects (licensed optional): specialist motion graphics, compositing, effects and VFX.
- Blender: 3D scenes, simulations and product visualization.
- Three.js: WebGL and procedural 3D.
- FilmCraft (free default) / Premiere Pro (licensed optional): editorial timeline, color, sound post and final assembly.
- FFmpeg: probing, processing, encoding and delivery validation.

## Delivery sequence
IR → route scene layers → render → optional EffectCraft/After Effects comps → FilmCraft/Premiere assembly → FFmpeg delivery → independent output inspection.

## Safety
Local process execution must use fixed executable paths and argument arrays. Do not edit project binaries directly (`.ecproj`/`.fcproj` are versioned JSON — treat them as derived artifacts; never binary-edit `.aep`/`.prproj`). Local render concurrency defaults to one. Skill evolution is proposal/evaluation/approval based; high-risk changes cannot be auto-promoted.

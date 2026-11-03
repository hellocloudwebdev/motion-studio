# Motion Studio Architecture Lock — 1.0 baseline

**Status:** Locked for the 0.1.x foundation build. Changes require an Architecture Decision Record (ADR), rationale, compatibility impact and migration plan.

## Product shape
One Motion Studio product, one provider-neutral core and multiple host adapters. Do not create separate implementations for each AI harness. Do not assume one plugin manifest or hook lifecycle works on every harness.

## Canonical project model
The versioned Canonical Video IR is the sole source of truth for creative intent, timing, assets, typography, motion, scene composition, QA, provenance and delivery. Engine-specific project files are derived artifacts. Timing is integer frames with rational frame rates.

## Locked production stack
| Domain | Locked choice | Boundary |
|---|---|---|
| Programmatic 2D | HyperFrames + GSAP | Titles, kinetic typography, graphics, data scenes |
| Advanced motion/VFX | Adobe After Effects | Specialist comps, compositing, tracking, VFX |
| Editorial | Adobe Premiere Pro | Timeline, pacing, tracks, captions, audio assembly |
| Adobe render queue | Adobe Media Encoder | Adobe-native queued rendering |
| 3D | Blender | 3D, simulation, product visualization |
| Procedural/WebGL 3D | Three.js | Shader/procedural browser-rendered work |
| Media pipeline | FFmpeg / FFprobe | Processing, encoding, probing, delivery validation |
| Supporting creative tools | Illustrator, Photoshop, Audition | Vector/raster asset preparation and audio cleanup |

DaVinci Resolve is not in the target stack. Remotion is not a primary engine; a future adapter is optional and must justify its maintenance cost.

## Fixed pipeline ordering
IR → per-layer scene routing → scene rendering → specialist After Effects comps where required → Premiere Pro editorial assembly → Media Encoder/FFmpeg delivery → independent output inspection. Not every scene needs every engine. Premiere is not a generic scene renderer.

## Orchestration and quality
Specialist agents are coordinated by a stateful orchestrator. Every run has explicit states, dependencies, artifacts and bounded repair cycles. QA is a gate, not a final opinion: technical, typography, visual and creative checks produce structured defects. Delivery requires verified final-export evidence.

## Local execution and security
Local-first execution. Local runtime binds to loopback only and requires a bearer token for protected operations. External app actions are allowlisted and scoped to a project workspace. Render concurrency defaults to one. No shell interpolation. No opaque binary editing of Adobe project files. Cloud rendering is opt-in.

## Learning governance
Project memory, user style memory and collective validated patterns remain separate scopes. The system may propose versioned skill/template/reference changes from evidence. Executable code, dependencies, secrets, permissions and core contracts cannot auto-promote.

## Portability
Shared skills, IR, MCP tools and agent role contracts are portable. Z Code, Claude Code, Codex and DeepSeek-compatible integrations are separate adapters. Compatibility must be tested against each host release; no universal manifest is claimed.

## Change control
The following require an ADR before implementation: replacing a primary engine, changing IR major version, changing final assembly ownership, changing the local security boundary, adding autonomous publishing, allowing cloud execution by default, or allowing automated promotion of code/permissions.

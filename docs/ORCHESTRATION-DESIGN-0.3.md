# Motion Studio 0.3 — Complete Production Orchestration Design

**Status:** Design baseline for the 0.3 implementation. The final architecture lock will be recorded after implementation and validation.

## 1. Product outcome

A user provides an idea, brief and optional assets. Motion Studio creates an editable Canonical Video Project IR, plans production, routes scene layers to the correct engines, renders previews, inspects actual media, repairs bounded defects, assembles the editorial timeline and delivers verified outputs.

The product is one shared production core with host-specific adapters. Adobe applications remain local desktop applications controlled through their own MCP bridges.

## 2. Installation and first-run experience

### 2.1 Supported platforms

- Windows 10/11 x64; ARM64 where upstream runtime and package support exists.
- macOS Intel and Apple Silicon.
- Linux x64/ARM64 for the open-source production path. Adobe desktop products are not part of the Linux support target.

**Node.js 24+ is the shared runtime baseline.** The After Effects MCP package requires Node 24+; HyperFrames requires Node 22+; Premiere MCP documents Node 20.19+. One managed Node 24+ runtime avoids incompatible global runtimes.

### 2.2 Installer phases

1. Detect OS, architecture, package manager, existing software, free disk space, memory and Node.js.
2. Install or stage Node 24+ in a user-owned toolchain directory without replacing a newer compatible runtime.
3. Install pinned Motion Studio workspace dependencies.
4. Install FFmpeg and FFprobe through a supported package manager or a verified project-local binary.
5. Install HyperFrames CLI and prepare its pinned headless browser.
6. Detect Blender; offer/install it as a free optional 3D engine.
7. Install the two pinned Adobe MCP npm packages locally: `@kumoproductions/mcp-aftereffects` and `premiere-pro-mcp`.
8. Detect After Effects and Premiere Pro installations.
9. If either Adobe app is missing, open Adobe's official Creative Cloud installation workflow and show a product-specific user action. Do not automate Adobe credentials, subscriptions, entitlements, purchases or activation.
10. Install the Premiere connector through an upstream-supported path. Prefer authenticated UXP on compatible Premiere 25.6+ when its release provides the required CCX connector and setup flow; retain the signed CEP connector for compatibility and operations not available through UXP. Never report a connector installed until local and live-host checks pass.
11. Register local stdio MCP services for Motion Studio, After Effects and Premiere in each supported AI host while preserving existing configuration.
12. Run the software doctor and read-only connection checks. Do not mutate Adobe projects during onboarding.

### 2.3 Software policy

| Software | Install policy | Runtime role |
|---|---|---|
| Node.js 24+ | Automated user-local bootstrap | Motion Studio and Adobe MCP runtime |
| FFmpeg / FFprobe | Automated package manager / verified local binary | Probe, encode, assemble and validate |
| HyperFrames CLI + browser | Automated npm + browser ensure | Main 2D and typography renderer |
| GSAP | Pinned workspace dependency | Deterministic motion timelines |
| Three.js | Pinned workspace dependency | Procedural/WebGL 3D; later renderer adapter |
| Blender | Free; optional automated install | 3D, simulation and product visualization |
| After Effects | Adobe Creative Cloud user install | Advanced motion, compositing, VFX and MOGRT |
| Premiere Pro | Adobe Creative Cloud user install | Editorial timeline and final assembly |
| Adobe Media Encoder | Adobe Creative Cloud user install | Adobe-native export queue |
| Illustrator / Photoshop / Audition | Optional Creative Cloud user install | Vector/raster asset prep and audio finishing |

Adobe applications are licensed products. The installer can detect them, open Creative Cloud, present the user install steps, poll for completion and validate application versions. It must not bypass Adobe sign-in, licensing, entitlement or trust UI. Adobe's installation flow requires the user's account and product availability.

### 2.4 Upstream Adobe MCPs

**After Effects**
- Package: `@kumoproductions/mcp-aftereffects`
- Repository: https://github.com/kumoproductions/mcp-aftereffects
- Integration: local stdio MCP process; no AE panel is required for normal single-instance mode.
- Upstream compatibility: After Effects 2024–2026, Windows/macOS, Node 24+.
- Required host preference: enable “Allow Scripts to Write Files and Access Network”.
- Start with `AE_MCP_READONLY=1` for connection verification; enable editing only after user approval of project scope.
- Keep `AE_MCP_ENABLE_EVAL` disabled. Do not expose arbitrary ExtendScript execution by default.
- Respect macOS Automation / Accessibility permissions and report them as user-granted prerequisites.
- Test on a copied project and checkpoint before mutations.

**Premiere Pro**
- Package: `premiere-pro-mcp`
- Repository: https://github.com/leancoderkavy/premiere-pro-mcp
- Integration: local stdio MCP process plus the upstream host connector.
- Prefer authenticated UXP on Premiere 25.6+ where installed release and live capability handshake support required operations. Keep CEP for compatibility and UXP gaps.
- UXP requires the same token in local server and panel configuration; store it in OS user-level secret storage or permission-restricted local config, never in git or project files.
- Run upstream `--doctor`, then the read-only `verify_premiere_connection` workflow with a test project and active sequence.
- Do not automatically replay a failed UXP mutation through CEP. Reconcile host state first.
- The upstream server's tool catalog, capability and authority profile are authoritative. Experimental QE operations remain labelled experimental.
- Do not grant `unsafe-script` authority by default.

Both projects are independent MIT-licensed MCP implementations, not Adobe products. Their packages are third-party executable code. Pin exact versions, install from official npm packages, record provenance, and do not fork or silently patch their code.

## 3. Component architecture

### 3.1 Main components

- **Host adapters:** Z Code, Claude Code, Codex, Cursor and generic MCP configuration.
- **Motion Studio MCP gateway:** stable, small tool surface for projects, production runs, routing, rendering, QA, software checks and explicit Adobe workflows.
- **Orchestrator:** state machine, task graph, run scheduler, artifact registry, retry/repair limits and approvals.
- **Canonical Video IR:** versioned production specification; engine projects and renders are derived artifacts.
- **Creative planner:** brief, research, script, storyboard, reference and art-direction contracts.
- **Design system:** brand tokens, responsive layout, typography/font resolution and motion preset registry.
- **Engine router:** evaluates each scene layer's capability needs, quality target, availability, license state, output contract, render cost and hardware constraints.
- **Engine adapters:** HyperFrames, After Effects MCP, Premiere MCP, Blender, Three.js and FFmpeg.
- **Asset manager:** path safety, content hashes, provenance, license state, fonts and media metadata.
- **Render manager:** queue, low-memory policies, checkpoints, cancellation, progress, logs and verified outputs.
- **QA and repair:** deterministic checks plus visual/audio inspection and bounded targeted repair.
- **Delivery manager:** Premiere sequence handoff, final encoding, format variants and export inspection.
- **Learning service:** scoped memory and versioned improvement proposals with evaluation and approval.

### 3.2 Authority boundaries

- Motion Studio owns project intent, Canonical Video IR, task state, delivery requirements and repair decisions.
- After Effects MCP owns its AE-specific project/layer operation surface.
- Premiere MCP owns its Premiere-specific project/timeline operation surface.
- Motion Studio never edits opaque `.aep` or `.prproj` binary files.
- A bridge connection is not proof that an edit succeeded. Every mutation requires tool-result inspection and host readback.
- Orchestrator must not blindly retry a non-idempotent Adobe mutation after a timeout; inspect host state and reconcile first.

### 3.3 MCP topology

Local-first topology, all on the user's machine:

```text
AI Host (Z Code / Claude / Codex / Cursor)
  └─ Motion Studio MCP Gateway
       ├─ Canonical IR + Creative Planning
       ├─ Orchestrator + Task Graph
       ├─ HyperFrames/GSAP Renderer
       ├─ FFmpeg + Render/QA Manager
       ├─ After Effects MCP Client
       │    └─ @kumoproductions/mcp-aftereffects (stdio)
       │         └─ Running After Effects application
       └─ Premiere MCP Client
            └─ premiere-pro-mcp (stdio)
                 └─ UXP/CEP connector in Premiere Pro
```

The upstream Adobe servers remain independent. Motion Studio uses MCP clients to discover and invoke their tools under a narrow policy-enforced orchestration contract. Optional direct host entries may be exposed for expert users, but the normal production agent should not receive hundreds of unfiltered tools. This keeps orchestration stable and avoids tool-list overload.

Use stdio, not a publicly exposed network server. Any optional dashboard/runtime binds to loopback, requires authentication and rejects non-loopback access unless separately reviewed.

## 4. Agent departments and contracts

| Department | Primary output |
|---|---|
| Executive Producer | Production brief, approvals, dependency graph, run status |
| Researcher | Source-backed facts, references and asset provenance |
| Creative Director | Concept, audience promise, tone and visual direction |
| Scriptwriter | Timed narration, on-screen copy and CTA |
| Storyboard Director | Timed scene/beat plan and asset callouts |
| Art Director | Palette, composition, graphic language and brand rules |
| Typography Specialist | Font decision, hierarchy, responsive scale and fit report |
| Asset Producer | Verified media, hashes, license status and prepared assets |
| Motion Designer | Motion grammar, transitions and animation plan |
| Engine Router | Engine assignments and output contracts by layer |
| HyperFrames Specialist | HTML composition and seekable GSAP timeline |
| After Effects Specialist | AE comps, advanced motion/VFX and approved render handoff |
| Premiere Editor | Sequence, edit decisions, track layout and final assembly |
| Blender Artist | 3D scene and render artifacts |
| Audio Producer | Narration, music/SFX stems, sync and mix plan |
| Technical QA | Structural, timing, media, codec and delivery evidence |
| Visual Critic | Frame-level composition, readability, consistency and defect notes |
| Creative Critic | Hook, narrative, pacing, brand and CTA quality |
| Repair Agent | Scoped, reversible repair plan and retest request |
| Skill Curator | Versioned skill proposals, evaluation evidence and rollback metadata |

Agents do not write the same canonical files concurrently. Orchestrator leases a project revision and scene/component scope to one writer; other agents submit patches/proposals.

## 5. Canonical production workflow

1. **Intake:** parse brief, audience, goals, duration, aspect ratios, language, platform, brand assets, references, approvals and delivery format.
2. **Preflight:** inspect toolchain, disk, RAM, installed apps, fonts, codecs, Adobe app presence, MCP connectivity and live engine capability.
3. **Research:** collect sources, claim evidence, usage rights and reference technique metadata.
4. **Creative direction:** set concept, tone, message hierarchy, pacing, brand grammar and guardrails.
5. **Script:** produce timed narration, on-screen copy, scene beats and CTA; flag unverified claims.
6. **Storyboard:** map each beat to a scene, frame range, composition, camera, layers, transition, audio cues and assets.
7. **Design system:** resolve brand tokens, typography scale, font availability/glyph coverage, safe areas, color, spacing and motion presets.
8. **Canonical IR:** compile everything into a validated, versioned document using integer frame timing and rational frame rates.
9. **Scene routing:** assign engine by layer capability; allow a scene to contain multiple engines and preserve a common output contract.
10. **Parallel preparation:** produce assets and independent scene source packages; heavy local rendering remains one worker by default.
11. **Draft rendering:** render low-quality/resolution previews; capture representative and boundary frames.
12. **QA:** validate IR, engine outputs, dimensions/FPS/duration, media/fonts, typography fit, safe areas, clipping, black frames, flicker, transitions, audio sync and creative quality.
13. **Repair:** create structured defects, assign an owner, change the smallest affected component, rerender it and retest. Maximum two automatic cycles by default; escalate thereafter.
14. **AE specialist comps:** use After Effects for advanced motion, compositing, effects and VFX not efficiently/faithfully available in the programmatic renderer. Save, checkpoint and inspect outputs.
15. **Premiere assembly:** import verified scene renders and AE comps; assemble cut, pacing, transitions, titles, narration, music and SFX.
16. **Finishing/export:** use Premiere/Media Encoder for editor-native finishing; FFmpeg for packaging, transcode, normalization, platform variants and media inspection.
17. **Delivery gate:** verify existence, codec, frame rate, dimensions, duration, color, audio streams and sampled frames. Only then mark delivered.
18. **Learning:** record decisions, defects, accepted repairs, render timings and feedback; create reviewed improvement proposals, never silent code changes.

## 6. Engine routing matrix

| Requirement | Engine |
|---|---|
| Kinetic type, 2D motion graphics, data graphics, titles, lower-thirds | HyperFrames + GSAP |
| Complex compositing, tracking, rotoscoping, particles, advanced typography, VFX | After Effects MCP |
| 3D models, lighting, camera, simulation, product visualization | Blender |
| Procedural WebGL, custom shader, realtime 3D | Three.js; follow-on adapter |
| Timeline editing, pacing, multi-track audio, captions, final sequence | Premiere Pro MCP |
| Probe, trim, image sequences, encode, audio mix, delivery variants | FFmpeg / FFprobe |

The router must check *live capability*, not just package presence. If an engine is missing, block or propose an explicit fallback. Never silently replace a required AE effect with a weaker renderer.

## 7. Canonical Video IR extensions

The current v1 schema remains backward-compatible. 0.3 may add optional sections:

- `production`: approvals, current phase, deliverables and run policy.
- `designSystem`: brand tokens, fonts, type scales, safe areas and motion presets.
- `assets`: path, content hash, source, license, rights status, font metadata and processing recipe.
- `scenes[].layers[]`: transform, layout, style, text, motion keyframes, engine hint, capabilities, assets and effect parameters.
- `scenes[].render`: scene output contract, draft profile and final profile.
- `timeline`: integer frame positions, tracks, transitions, markers and audio routing.
- `adobe`: optional generated-project references and live host versions, never opaque Adobe binary payloads.
- `qa`: findings, sampled frames/audio, repair records and approvals.
- `provenance`: source inputs, package/app versions, fonts/licenses, tool call IDs and render settings.

All time is integer frames. Convert frames to HyperFrames' second-based data attributes using the exact rational frame rate and deterministic formatting.

## 8. HyperFrames compiler and render contract

The 0.3 compiler generates a self-contained project directory:

```text
projects/<project-id>/engines/hyperframes/
  index.html
  assets/
  motion-studio.json
  render-manifest.json
  renders/
  snapshots/
```

- Root registers a `data-composition-id`, dimensions and paused GSAP timeline in `window.__timelines`.
- Timed visual elements get HyperFrames timing attributes: `data-start`, `data-duration`, `data-track-index` and `class="clip"` where required.
- HyperFrames owns media playback and clip lifecycle; do not manually seek/play media in scripts.
- Extend GSAP timeline to exact scene duration even if last animation ends early.
- Generate deterministic IDs, safe relative asset paths, type tokens and sorted output.
- Render through pinned HyperFrames CLI: `lint`, `check`, `snapshot` then `render`.
- Use `--workers 1` by default for low-memory systems.
- Record HyperFrames/browser versions and output provenance.
- Probe MP4 with FFprobe and extract frames for QA.
- Same IR revision + same toolchain should produce consistent visual state for a fixed frame.

## 9. Render scheduler and execution graph

Node states: `pending`, `ready`, `running`, `succeeded`, `failed`, `blocked`, `cancelled` and `needs-review`.

Each task records ID, project revision, scope, engine, input hashes, output contract, dependencies, resource needs, retry policy, timeout, owner and checkpoint.

Resource policy:
- local workers default to 1;
- memory-aware admission control; do not concurrently render Blender/AE/Chrome on low-memory systems;
- resume from last verified scene artifact;
- cancel only the child process started by that task;
- record logs and exit evidence;
- use explicit executable + argv array, never shell-interpolate user text;
- keep outputs at derived paths and preserve source assets/IR.

## 10. QA and repair policy

### Deterministic checks
- IR schema/semantics, duplicate IDs and exact frame arithmetic.
- Asset references resolve within approved project roots unless explicitly approved as external.
- Required fonts installed and glyphs covered; no silent substitution.
- HyperFrames lint/check, composition duration and render exit status.
- FFprobe: dimensions, FPS, duration, codec, color space, pixel format and audio streams.
- Output files exist and are non-empty; sampled frames decode and are not unexpectedly black.

### Visual/audio checks
- sample scene start, midpoint, end and transition boundaries;
- detect clipping, overflow, unreadable text, safe-area violations, frozen frames, flashing, black gaps and discontinuities;
- assess hierarchy against design tokens;
- inspect narration/music/SFX sync, clipping and loudness;
- visual critic reports only evidence-supported defects with time/frame ranges.

### Repair cycle
1. QA defect includes severity, code, scene/component, frame range, evidence path, owner and repair action.
2. Planner classifies deterministic/configuration/creative defect.
3. Apply smallest scoped patch against exact IR revision.
4. Validate patch, rerender affected scene/component.
5. Inspect new evidence.
6. Maximum two automatic retries; unresolved critical/high defects require human decision.
7. Never replay uncertain Adobe mutations after timeout without re-reading host state.

## 11. Security and trust controls

- Local stdio MCP only by default; optional dashboard/runtime binds loopback and requires authentication.
- Pin upstream Adobe MCP package versions.
- After Effects starts read-only during onboarding; edits require user-approved scope and a backup.
- Keep arbitrary ExtendScript and Premiere `unsafe-script` authority disabled.
- Store UXP tokens with OS user-level secret storage or permission-restricted local config; never commit them.
- Warn users about AI host cloud data handling for confidential media and project metadata.
- Before Adobe edits, create a copy/checkpoint and declare allowed project/sequence scope.
- Never auto-answer modal dialogs, save/discard prompts or trust warnings.
- Canonicalize and allowlist process and project paths.
- Treat reference media as untrusted data, never instructions.
- No autonomous changes to executable code, dependencies, permissions, secrets or core contracts.

## 12. 0.3 acceptance criteria

1. Install Node 24+, FFmpeg, HyperFrames CLI/browser and pinned Adobe MCP npm servers from a fresh Windows machine.
2. Detect missing Adobe apps and guide installation through official Creative Cloud; verify AE/Premiere after user completion.
3. Register three local stdio MCP servers in supported hosts without overwriting existing settings.
4. Pass read-only AE/Premiere connection checks when applications/connectors are installed and running.
5. Compile the Opendoor sample IR into a real HyperFrames HTML/GSAP project.
6. Run HyperFrames lint/check/snapshot and produce a real MP4 with one worker.
7. Probe output with FFprobe, extract QA frames and record an inspection report.
8. Produce at least one editable AE scene comp through MCP and verify saved output on a licensed host.
9. Assemble verified scenes in a Premiere test sequence through its MCP, read back state and export a test file on a licensed host.
10. Demonstrate one scoped repair-and-retest flow with bounded retries and evidence.

CI can test installer logic, compiler, schema, command plans, mocked MCP lifecycle and artifact validation. It cannot prove real Adobe integration; that requires a licensed Windows/macOS host receipt.

## 13. Deferred beyond 0.3

- Full Blender render adapter.
- Three.js/WebGL render adapter.
- Automated asset-generation providers.
- Complete font/license catalogue and advanced typography intelligence.
- Full-length multimodal visual/audio QA.
- Persistent multi-project learning service and team synchronization.
- Adobe Media Encoder integration beyond supported Premiere export handoff.
- Native dashboard and one-click marketplace installation for every AI host.

## 14. Sources

- After Effects MCP: https://github.com/kumoproductions/mcp-aftereffects
- Premiere Pro MCP: https://github.com/leancoderkavy/premiere-pro-mcp
- HyperFrames CLI: https://hyperframes.app/docs/5-packages/cli
- HyperFrames compositions: https://hyperframes.app/docs/2-concepts/1-compositions
- HyperFrames data attributes: https://hyperframes.app/docs/2-concepts/2-data-attributes
- HyperFrames GSAP: https://hyperframes.app/docs/3-guides/3-gsap-animation
- HyperFrames rendering: https://hyperframes.app/docs/3-guides/4-rendering
- Adobe Creative Cloud installation: https://helpx.adobe.com/download-install/apps/download-install-apps/creative-cloud-apps/download-creative-cloud-apps.html
- Premiere UXP: https://developer.adobe.com/premiere-pro/uxp/
- After Effects UXP: https://developer.adobe.com/after-effects/uxp/

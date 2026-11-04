# Motion Studio 0.4 — Adobe Production Orchestration

**Status:** 0.4 design baseline. This is an implementation contract for the Adobe workflow phase, not the final product architecture lock.

## 1. Outcome

0.4 makes Motion Studio actively orchestrate real After Effects and Premiere workflows through the selected upstream MCP servers. Motion Studio remains the system of record for the Canonical Video IR, workflow plans, approvals, artifact provenance and run state. Adobe-specific operations remain owned by the upstream servers.

The first complete cross-app workflow is:

1. Read and validate a Canonical Video IR scene.
2. Preview the proposed AE composition/layer changes.
3. Require explicit approval and create a collision-safe copy of the current AE project.
4. Create an editable After Effects composition from supported IR text/shape layers.
5. Save and read back the composition.
6. Render the main scene through HyperFrames, or a specialist scene through AE.
7. Preview the completed media handoff into Premiere.
8. Require separate approval, save/backup the Premiere project, import scene renders and create a new sequence.
9. Read back sequence/clip structure and save the project.
10. Optionally export with Premiere/AME and verify the resulting media file.
11. Store a machine-readable workflow receipt including host versions, capabilities, paths, artifact hashes, step results, readback and unresolved warnings.

## 2. Boundary and dependency rules

- Motion Studio uses `@kumoproductions/mcp-aftereffects` and `premiere-pro-mcp` through the MCP SDK client already in the repository.
- Do not fork either upstream server, implement their Adobe scripting transports, edit `.aep` / `.prproj` binary structures or reverse engineer Adobe project file formats.
- Every upstream tool invocation must be discovered from `tools/list` on that live server connection. Every AE atomic operation must additionally be discovered through `ae_catalog`.
- The upstream schema/host capability response is authoritative. Do not assume that a package being installed means the host supports every operation.
- Use public operations, not raw ExtendScript or Premiere `unsafe-script`.
- After Effects' default onboarding/read-only profile remains. Switch to edit authority only for a specific approved run, and scope allowed categories.
- Premiere's default remains inspect-only. Edit/export authority is enabled only inside an approved run. Do not include `unsafe-script`.
- Local stdio transport only. No public network listener or cloud-hosted Adobe bridge.

## 3. Connection and live capability model

A host is ready only when all applicable checks pass:

**After Effects**
- MCP process starts and completes MCP initialization.
- Required tools `ae_context`, `ae_project_info`, `ae_catalog`, `ae_do`, `ae_save_project` are available.
- `ae_context` returns a live instance and project state.
- `ae_project_info` returns an open, saved project with a path.
- Project is not dirty before the backup operation; unsaved changes must be saved by the user.
- Requested atomic operations are returned by `ae_catalog` under the active permissions and their parameters validate the planned arguments.
- AE version and required capabilities are captured from `ae_version_info` when available.

**Premiere Pro**
- MCP process starts and completes MCP initialization.
- Required tools `verify_premiere_connection`, `get_project_info`, `import_media`, `create_sequence_from_clips`, `get_sequence_structure`, `save_project` are available.
- `verify_premiere_connection` returns host-verified status using the selected backend.
- Project is open and saved to an absolute path.
- Capability/authority profile advertises the exact tools needed by the selected route.
- Project path is unchanged between preview and apply.
- Backend (CEP or authenticated UXP) is captured with version/capability response. Do not assume operation parity between the two.

When a host is unavailable, report the exact preflight failure and keep the task blocked. Do not silently replace an Adobe operation with a weaker renderer.

## 4. Permission and approval model

Every host workflow follows:

`inspect → plan → preview → user approval → backup/checkpoint → apply → readback → save → receipt`

- Preview is read-only and issues a single-use, expiring token bound to the plan, project identity, host/backend and required output paths.
- Apply requires the exact token and explicit `approved=true`.
- Tokens expire after 30 minutes, are single-use, and are consumed before the first mutation attempt. A failed/uncertain mutation is not replayable by retrying the same token.
- Any project, sequence, asset, file or host revision drift invalidates the preview and requires a new preview.
- The agent cannot manufacture approval; approval must originate from the user-visible action/host client.
- A workflow with no valid backup destination is refused before mutation.
- System preferences, scripts, plugins, application configuration, licensing, login and security settings are outside normal project-workflow permissions.

## 5. After Effects workflow

### 5.1 First 0.4 scope

- Inspect current AE context, project path/dirty state and AE version.
- Require an existing saved project, an explicit backup path and a user-approved scene plan.
- Copy the saved `.aep` file to a new, non-existing backup path before mutation. Refuse unsaved/dirty projects rather than backing up stale disk state.
- Use `ae_catalog` to inspect the exact operation schemas before each planned action.
- Create one composition using `comp.create`.
- Create text layers with `layer.create_text` (paragraph text when the IR specifies a text box).
- Apply supported typography through `text.set_style`, using PostScript font names only when supplied/verified.
- Set geometry with `transform.set`.
- Add basic fade/fade-up motion using `keyframe.add` when its live schema and operation are available. If it is unavailable, report a warning and do not invent a substitute.
- Create simple color rectangles with `layer.create_solid`.
- Save through `ae_save_project` and read back via `ae_comp_info` / `ae_project_info`.
- Advanced VFX, tracking, rotoscoping, complex shape paths, expressions and arbitrary scripts remain manual specialist operations or follow-on work.

### 5.2 Failure behavior

Each AE operation is an individual upstream MCP mutation and an undoable host operation. Record step receipts. Stop at the first failed/unverified step. Never retry a timed-out call without a fresh context/readback and human reconciliation. A backup copy is the recovery point; Motion Studio does not automatically overwrite or restore the active project.

## 6. Premiere workflow

### 6.1 First 0.4 scope

- Read-only connection verification and project identity capture.
- Require a saved project and explicit non-existing backup path. Save first; copy the project file before mutation.
- Verify each scene render path is absolute, exists, is a regular file and is not repeated.
- Import the rendered scene files using the upstream `import_media` tool and require per-file node-ID/path readback.
- Create a **new** sequence from imported media using `create_sequence_from_clips`. This avoids modifying the user's existing active sequence and avoids guessing timeline timing.
- Read back the active sequence and its structure; require the expected imported clips in the new sequence.
- Save through `save_project`.
- Optional export through `export_sequence` with a user-specified output path and, when provided, an Adobe Media Encoder `.epr` preset. Verify the written artifact with `verify_delivery_file`.
- For a handoff path from an AE render into a chosen existing Premiere bin, call the upstream `preview_after_effects_render_handoff` then `apply_after_effects_render_handoff` flow with its exact token/confirmation schema. Do not emulate or bypass that approval contract.

### 6.2 Not in the first 0.4 scope

- Destructive operations on an existing timeline.
- Reordering, trimming, transitions, audio automation, multicam or advanced keyframe work.
- Arbitrary QE DOM operations.
- Raw ExtendScript / unsafe-script.
- Batch replacement of existing clips.
- Unattended AME queue starts that might render unrelated jobs.

## 7. Canonical Video IR mapping

IR remains renderer/editor independent. 0.4 adds an adapter mapping, not an Adobe-specific master schema.

Supported initial AE layer mapping:
- `text` → text layer; text, font PostScript name, size, fill color, alignment, box geometry, transform, basic opacity/position keyframes.
- `shape` → solid rectangle when rectangular geometry/fill are explicitly described.
- Other kinds remain routed to HyperFrames, Blender, Three.js, or another specialist engine and appear as explicit exclusions in the AE plan.

Premiere mapping:
- ordered verified scene-render artifact files → imported project media items → new Premiere sequence in input order.
- Project frame rate and target delivery format must match the imported scene artifacts; sequence creation from clips may inherit/resolve settings based on the first source, so post-creation settings require readback.
- Never infer exact cross-engine transitions, audio mixes, or editorial trims from scene array order alone.

## 8. Cross-app orchestration

The workflow graph uses typed tasks:

- `preflight.ae`
- `preview.ae.scene`
- `backup.ae.project`
- `apply.ae.scene`
- `verify.ae.composition`
- `render.scene.hyperframes` or `render.scene.ae`
- `preflight.premiere`
- `preview.premiere.assembly`
- `backup.premiere.project`
- `import.premiere.media`
- `create.premiere.sequence`
- `verify.premiere.sequence`
- `save.premiere.project`
- `export.premiere.sequence`
- `verify.delivery`

Dependencies are explicit. HyperFrames scenes may render independently; local heavy engine concurrency remains one by default. Adobe project mutations are serialized per application/project. The orchestrator must never run AE and Premiere mutations concurrently against the same shared output artifacts.

## 9. Receipt and provenance

Each run persists:
- run ID, project ID and IR revision/hash;
- workflow plan hash and preview ID hash (never the confirmation token);
- app versions, MCP package versions, bridge/backend/capabilities;
- input asset hashes and approved workspace boundaries;
- backup file path/hash;
- tool name, operation name, sanitized args hash, start/end timestamps, status and result hash;
- host readback and artifact verification;
- warnings, unresolved defects and human approval record.

Do not log secrets, UXP tokens, arbitrary ExtendScript, private project contents or raw asset paths unless needed in the local user-owned run receipt. Cloud AI-host privacy warning remains applicable.

## 10. Learning and orchestration governance

- Agent roles may propose scene operations, but only the orchestrator dispatches host mutations.
- Each host/project writer has a single-writer lease.
- Repair agents may propose changes. They cannot self-approve.
- No blind retries. All uncertain outcomes move to `needs-reconciliation`.
- No autonomous changes to dependencies, MCP authority, application permissions, secrets, user plugins or executable code.
- Only completed, readback-verified steps feed workflow evaluation.

## 11. 0.4 acceptance gates

1. CI tests capability discovery and operation-schema validation against fixture tool catalogs.
2. CI tests approval-token binding, expiration, single-use and revision drift rejection.
3. CI tests backup path safety, collision refusal and project-dirty refusal.
4. CI tests AE operation planning and correct Canonical IR conversion.
5. CI tests Premiere media import result parsing, sequence creation mapping and export/verification stop conditions with mocked MCP clients.
6. Real licensed AE host: create one sample comp with title/shape layers, save, reopen/readback and preview frame receipt.
7. Real licensed Premiere host: import two real rendered scenes, create a new sequence, save, read back the expected clips and export a short MP4.
8. Cross-app run receipt records actual AE/Premiere versions and evidence. CI/mock tests alone do not count as licensed-host validation.

## 12. Deferred to later milestones

- 0.5 Blender and Three.js renderer adapters.
- 0.6 multimodal visual/audio QA and automatic repair.
- 0.7 persistent production memory and evaluated skill evolution.
- 1.0 end-to-end install/upgrade distribution, production benchmarks and final architecture lock.

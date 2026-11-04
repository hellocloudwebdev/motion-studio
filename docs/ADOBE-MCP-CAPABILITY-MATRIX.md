# Adobe MCP capability mapping — 0.4

This matrix records upstream MCP surfaces used by Motion Studio. At runtime, `tools/list`, `ae_catalog`, Premiere `get_capabilities` and host preflight are authoritative.

## After Effects — kumoproductions/mcp-aftereffects

Package: `@kumoproductions/mcp-aftereffects@0.3.2`  
Repository: https://github.com/kumoproductions/mcp-aftereffects  
Compatibility: AE 2024–2026, Windows/macOS, Node 24+.

| MCP surface | Motion Studio use | Policy |
|---|---|---|
| `ae_context` | Instance/project/active-comp preflight | Read-only |
| `ae_project_info` | Saved path, dirty state and item identity | Read-only |
| `ae_version_info` | Host version and capability receipt | Read-only |
| `ae_catalog` | Discover exact atomic operation names and schemas | Read-only |
| `ae_do` | Dispatch allowlisted operations such as comp/layer/text/transform/keyframe | Edit mode only, live catalog/schema required |
| `ae_comp_info` | Read back generated composition | Read-only |
| `ae_layer_info` | Read back generated layer properties | Read-only |
| `ae_save_project` | Save after approved modifications | Edit mode, backup required |
| `ae_render_frame` | Capture PNG proof frame | Read-only after save |

Initial atomic operations:
- `comp.create`
- `layer.create_text`
- `layer.create_solid`
- `text.set_style`
- `transform.set`
- `keyframe.add`

Do not enable `AE_MCP_ENABLE_EVAL`. Set `AE_MCP_READONLY=1` on onboarding. When an explicit approved edit is active, use `AE_MCP_ALLOW_CATEGORIES=comp,layer,text,transform,keyframe,project,render,item` and continue to omit eval.

## Premiere Pro — leancoderkavy/premiere-pro-mcp

Package: `premiere-pro-mcp@1.29.0`  
Repository: https://github.com/leancoderkavy/premiere-pro-mcp  
Compatibility: Windows/macOS, Premiere 2020–2026; authenticated UXP on supported 25.6+ hosts, CEP compatibility routes for other features/versions.

| MCP surface | Motion Studio use | Policy |
|---|---|---|
| `verify_premiere_connection` | Verify MCP server, selected backend, open project and active sequence | Read-only |
| `get_capabilities` | Discover backend/authority/host support | Read-only |
| `get_project_info` | Project identity and saved path | Read-only |
| `get_active_sequence` | Active sequence preflight | Read-only |
| `get_sequence_structure` | Timeline structural readback | Read-only |
| `import_media` | Import verified scene files | Explicit approval + project backup |
| `create_sequence_from_clips` | Create a new sequence from imported clips | Explicit approval + project backup |
| `save_project` | Save approved project changes | Explicit approval |
| `export_sequence` | Export sequence through Premiere/AME | Explicit output path + export approval |
| `verify_delivery_file` | Verify file existence, size and checksum | Read-only |
| `preview_after_effects_render_handoff` | Preview AE-to-Premiere asset handoff | Read-only approval preview |
| `apply_after_effects_render_handoff` | Apply approved AE render import into selected bin | Upstream one-time confirmation token |

The first 0.4 assembly route deliberately creates a **new sequence** from imported scene renders. It does not automatically rewrite the user's existing timeline.

## Authority profiles

Default local launch:
- AE: `AE_MCP_READONLY=1`; no eval.
- Premiere: `PREMIERE_MCP_CAPABILITIES=inspect`; inspection tool pack only.
- Local stdio, no HTTP listener.

Approved workflow:
- AE: `AE_MCP_READONLY=0`; allowlisted operation categories only; no eval.
- Premiere: `PREMIERE_MCP_CAPABILITIES=inspect,edit,export,filesystem`; explicitly selected tool list only; no `unsafe-script`.

Neither tool availability nor connector panel status proves that an application edit succeeded. Readback and host-specific receipt are required.

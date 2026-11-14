# Software installation matrix — Motion Studio 0.4 (craft stack)

| Software | Pinned version / range | Role | Install method | License / user action |
|---|---|---|---|---|
| Node.js | 24+; bootstrap major 26 | Runtime | User-local bootstrap / WinGet | Free |
| FFmpeg / FFprobe | OS package version | Media pipeline | OS package manager | Open source |
| HyperFrames | 0.8.86 | HTML/GSAP composition and render | npm workspace | Open source |
| GSAP | 3.14.2 | Motion sequencing | npm workspace | Check current license terms for commercial distribution |
| Three.js | 0.181.2 | WebGL scene support | npm workspace | MIT |
| Blender | System package | 3D scenes | OS package manager | GPL |
| EffectCraft | alpha (GitHub releases) | Specialist motion graphics / VFX / compositing | GitHub releases or getartcraft.com (MSI/DMG/AppImage/pkg) | Free, MIT OR Apache-2.0 |
| FilmCraft | alpha (GitHub releases) | Editorial assembly, color, sound post, export | GitHub releases or getartcraft.com (MSI/DMG/AppImage/pkg) | Free, MIT OR Apache-2.0 |
| craft-mcp-client | @motion-studio/craft-mcp-client (workspace) | MCP client + approval gate for both craft tools | npm workspace | MIT |

## Version compatibility notes

- Both craft CLIs require no Adobe account, no CEP/UXP connectors and no token setup; they expose headless MCP servers over stdio (`effectcraft-cli mcp`, `filmcraft-cli -- mcp`).
- `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI` environment overrides point Motion Studio at portable installs; PATH and known per-user install roots are probed otherwise.
- Both tools are alpha: Motion Studio treats every render receipt with independent FFprobe verification, and every mutation passes the explicit producer approval gate.
- Motion Studio renders FCPXML 1.10 editorial interchange, which FilmCraft imports natively (alongside FCP7 XML, OTIO, EDL, AAF, OMF).
- Installing a craft CLI does not prove a render succeeds; runtime verification belongs to the doctor/preflight evidence flow.

See [software lock](../configs/software-lock.json) and the [installer policy](INSTALLER-CRAFT-POLICY.md).

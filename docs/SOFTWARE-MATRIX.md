# Software installation matrix — Motion Studio 0.4 (dual stack)

| Software | Pinned version / range | Role | Install method | License / user action |
|---|---|---|---|---|
| Node.js | 24+; bootstrap major 26 | Runtime | User-local bootstrap / WinGet | Free |
| FFmpeg / FFprobe | OS package version | Media pipeline | OS package manager | Open source |
| HyperFrames | 0.8.86 | HTML/GSAP composition and render | npm workspace | Open source |
| GSAP | 3.14.2 | Motion sequencing | npm workspace | Check current license terms for commercial distribution |
| Three.js | 0.181.2 | WebGL scene support | npm workspace | MIT |
| Blender | System package | 3D scenes | OS package manager | GPL |
| EffectCraft | alpha (GitHub releases) | Default specialist motion graphics / VFX / compositing | GitHub releases or getartcraft.com (MSI/DMG/AppImage/pkg) | Free, MIT OR Apache-2.0 |
| FilmCraft | alpha (GitHub releases) | Default editorial assembly, color, sound post, export | GitHub releases or getartcraft.com (MSI/DMG/AppImage/pkg) | Free, MIT OR Apache-2.0 |
| craft-mcp-client | @motion-studio/craft-mcp-client (workspace) | MCP client + approval gate for the craft tools | npm workspace | MIT |
| After Effects MCP | @kumoproductions/mcp-aftereffects 0.3.2 | Licensed AE local control via MCP (optional stack) | npm workspace | MIT; requires AE 2024–2026 and user host permissions |
| Premiere Pro MCP | premiere-pro-mcp 1.30.0 | Licensed Premiere timeline control via MCP (optional stack) | npm workspace | MIT; requires Premiere + UXP/CEP connector |
| Premiere UXP connector | v1.30.0 direct CCX | Premiere 25.6+ bridge (optional stack) | Official release asset, Creative Cloud install | User installs/trusts connector and configures token |
| Premiere CEP connector | v1.30.0 signed ZXP | Older Premiere compatibility (optional stack) | Upstream `--install-premiere-cep` command | Close Premiere before install |
| After Effects | 2024–2026 | Licensed advanced motion/VFX/compositing (optional) | Adobe Creative Cloud | Paid; user signs in and activates |
| Premiere Pro | 2020–2026 | Licensed editorial assembly (optional) | Adobe Creative Cloud | Paid; user signs in and activates |
| Media Encoder | Eligible Adobe plan version | Licensed Adobe export queue (optional) | Adobe Creative Cloud | Paid/included with eligible plan |

## Version compatibility notes

- Dual stacks: EffectCraft + FilmCraft are the free default specialist/editorial engines; the licensed Adobe stack is retained for subscribed hosts. A scene's `engineHint` (or `MOTION_STUDIO_EDITORIAL_ENGINE=premiere-pro` for assembly) selects which stack a production uses; never mix stacks inside one scene.
- The craft CLIs require no Adobe account and no CEP/UXP connectors; they expose headless MCP servers over stdio (`effectcraft-cli mcp`, `filmcraft-cli -- mcp`). `EFFECTCRAFT_CLI` / `FILMCRAFT_CLI` overrides point Motion Studio at portable installs.
- Both craft tools are alpha: Motion Studio treats every render receipt with independent FFprobe verification, and every mutation passes the explicit producer approval gate.
- The Adobe MCP packages require Node.js 24+; onboarding is read-only/inspect-only, `AE_MCP_ENABLE_EVAL` is never set by the installer and Premiere `unsafe-script` authority stays disabled.
- Motion Studio renders FCPXML 1.10 editorial interchange, which FilmCraft imports natively (alongside FCP7 XML, OTIO, EDL, AAF, OMF) and Premiere Pro imports as FCPXML.
- Installing an MCP package or CLI does not prove a render succeeds; runtime verification belongs to the doctor/preflight evidence flow.

See [software lock](../configs/software-lock.json) and the [installer policy](INSTALLER-CRAFT-POLICY.md).

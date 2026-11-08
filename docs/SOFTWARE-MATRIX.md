# Software installation matrix — Motion Studio 0.3

| Software | Pinned version / range | Role | Install method | License / user action |
|---|---|---|---|---|
| Node.js | 24+; bootstrap major 26 | Runtime | User-local bootstrap / WinGet | Free |
| FFmpeg / FFprobe | OS package version | Media pipeline | OS package manager | Open source |
| HyperFrames | 0.8.86 | HTML/GSAP composition and render | npm workspace | Open source |
| GSAP | 3.14.2 | Motion sequencing | npm workspace | Check current license terms for commercial distribution |
| Three.js | 0.181.2 | WebGL scene support | npm workspace | MIT |
| Blender | System package | 3D scenes | OS package manager | GPL |
| After Effects MCP | @kumoproductions/mcp-aftereffects 0.3.2 | AE local control via MCP | npm workspace | MIT; requires AE 2024–2026 and user host permissions |
| Premiere Pro MCP | premiere-pro-mcp 1.30.0 | Premiere timeline control via MCP | npm workspace | MIT; requires Premiere + UXP/CEP connector |
| Premiere UXP connector | v1.30.0 direct CCX | Premiere 25.6+ bridge | Official release asset, Creative Cloud install | User installs/trusts connector and configures token |
| Premiere CEP connector | v1.30.0 signed ZXP | Older Premiere compatibility | Upstream `--install-cep` command | Close Premiere before install |
| After Effects | 2024–2026 | Advanced motion/VFX/compositing | Adobe Creative Cloud | Paid; user signs in and activates |
| Premiere Pro | 2020–2026 | Editorial assembly | Adobe Creative Cloud | Paid; user signs in and activates |
| Media Encoder | Eligible Adobe plan version | Adobe export queue | Adobe Creative Cloud | Paid/included with eligible plan |
| Illustrator / Photoshop / Audition | Current supported Adobe releases | Supporting creative tools | Adobe Creative Cloud | Optional; paid |

## Version compatibility notes

- The After Effects MCP package requires Node.js 24+.
- HyperFrames requires Node.js 22+; Motion Studio standardizes on Node 24+ for both Adobe MCPs and the renderer.
- The npm package and UXP/CEP connector are pinned to the matching published v1.30.0 release.
- Premiere 25.6+ supports the preferred authenticated UXP path when the selected package version exposes the required operation. CEP remains a compatibility path. UXP/CEP capabilities are not interchangeable; a failed UXP mutation is never blindly replayed through CEP.
- Installing an MCP package does not prove that the desktop application is installed, running, licensed or connected.

See [software lock](../configs/software-lock.json) and [Adobe installation policy](INSTALLER-ADOBE-POLICY.md).

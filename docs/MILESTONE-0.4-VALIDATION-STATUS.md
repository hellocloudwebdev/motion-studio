# Motion Studio 0.4 — Validation Status

**Branch:** `milestone/0.4-adobe-production-orchestration`  
**Pull request:** [#2](https://github.com/hellocloudwebdev/motion-studio/pull/2)  
**Validated head:** `d28d7a3b18628e934c63b0a3a9f76ebdad0b173d`  
**CI:** [run 42385125847](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42385125847) — all 7 jobs passed (six Windows/macOS/Linux × Node 24/26 matrix jobs plus real render smoke).  
**Render evidence:** [MP4, QA frames and receipt artifact](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42385125847/artifacts/13578804696)  
**Status:** code validation and automated HyperFrames render acceptance passed; licensed Adobe and installer lifecycle acceptance remain open.

## Implemented in the branch

- Approval-bound After Effects scene preview/apply workflow, live operation-catalog validation, project backup, save/readback and PNG frame proof.
- Approval-bound Premiere scene import/new-sequence workflow, backup, source identity checks, paginated sequence readback, save and optional Media Encoder export using an explicit `.epr` preset.
- High-level Motion Studio MCP tools; upstream Adobe tools remain scoped and unsafe scripting remains disabled.
- Per-host in-process mutation serialization, one-time approval lifecycle, reconciliation-required failure state and sanitized local run receipts.
- Mocked MCP integration tests and policy/unit tests.
- HyperFrames compiler writes child scene compositions under `compositions/`, preserving one root `index.html` for the HyperFrames project.
- A deterministic 2-second, 640×360, 24 fps Canonical Video IR fixture and a Linux CI job that installs FFmpeg, prepares the pinned HyperFrames browser, renders an actual H.264 MP4, verifies it with FFprobe, extracts QA frames and uploads a receipt.

## Validation results

1. **Cross-platform code CI:** passed all six Windows/macOS/Linux × Node 24/26 jobs.
2. **Real HyperFrames render:** passed. Output: H.264 MP4, 640×360, 24 fps, 2.0 seconds, 33,758 bytes. FFprobe verified dimensions, frame rate, duration and video stream. HyperFrames check passed; QA frame extraction completed. The receipt reports `verified: true` and `productionReady: true`.
3. **Licensed Adobe host tests:** still require a machine with licensed After Effects and Premiere Pro plus the corresponding bridges installed. Attach real project-save, readback, PNG proof and export/checksum receipts. Mocked MCP tests do not substitute for this.
4. **Installer acceptance:** still requires fresh-machine clean install, upgrade, repeat-install and uninstall on Windows, plus macOS/Linux setup lifecycle smoke tests. The CI unit matrix is not a substitute for lifecycle acceptance.

## Environment constraints and exit decision

The development environment used for this milestone does not have licensed Adobe desktop applications available. Adobe licensing, sign-in, installation and trust prompts remain user-controlled.

Do not merge 0.4 as a fully verified production milestone, start 0.5, or declare final architecture lock until the licensed Adobe and installer lifecycle evidence is recorded. The automated render gate is now closed with CI evidence; the remaining gates are not waived.

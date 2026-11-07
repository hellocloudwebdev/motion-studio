# Motion Studio 0.4 — Validation Status

**Branch:** `milestone/0.4-adobe-production-orchestration`  
**Pull request:** [#2](https://github.com/hellocloudwebdev/motion-studio/pull/2)  
**Current implementation:** includes the 0.4 Adobe orchestration work plus a dedicated real-render CI smoke path.  
**Cross-platform CI:** the six-job Windows/macOS/Linux × Node 24/26 matrix passed on the prior code head. The updated workflow is running against the current head; see [latest workflow runs](https://github.com/hellocloudwebdev/motion-studio/actions).  
**Status:** code-level validation is green on the prior head; the new render smoke and remaining host/installer acceptance are not yet signed off.

## Implemented in the branch

- Approval-bound After Effects scene preview/apply workflow, live operation-catalog validation, project backup, save/readback and PNG frame proof.
- Approval-bound Premiere scene import/new-sequence workflow, backup, source identity checks, paginated sequence readback, save and optional Media Encoder export using an explicit `.epr` preset.
- High-level Motion Studio MCP tools; upstream Adobe tools remain scoped and unsafe scripting remains disabled.
- Per-host in-process mutation serialization, one-time approval lifecycle, reconciliation-required failure state and sanitized local run receipts.
- Mocked MCP integration tests and policy/unit tests.
- A small deterministic Canonical Video IR fixture and Linux CI job that installs FFmpeg, prepares the HyperFrames browser, renders an actual MP4, probes the output with FFprobe, extracts QA frames, and uploads the render/receipt as a CI artifact.

## Validation gates

1. **Cross-platform code CI:** prior current-head matrix passed all six Windows/macOS/Linux × Node 24/26 jobs. Reconfirm on the newest head.
2. **Real HyperFrames render:** automated render/FFprobe/QA smoke is now wired into CI. Treat this gate as pending until the new `render-smoke` job passes and its artifact is available.
3. **Licensed Adobe host tests:** still require a machine with licensed After Effects and Premiere Pro plus the corresponding bridges installed. Attach real project-save, readback, PNG proof and export/checksum receipts. Mocked MCP tests do not substitute for this.
4. **Installer acceptance:** still requires fresh-machine clean install, upgrade, repeat-install and uninstall on Windows, plus macOS/Linux setup smoke tests. The CI unit matrix is not a substitute for lifecycle acceptance.
5. **Final delivery decision:** do not merge 0.4 as a verified production milestone, start 0.5, or declare final architecture lock until the applicable acceptance evidence is recorded.

## Environment constraints

The development environment used for this milestone does not have licensed Adobe desktop applications available. That is a validation constraint, not a reason to fabricate host receipts. Adobe licensing, sign-in, installation and trust prompts remain user-controlled.

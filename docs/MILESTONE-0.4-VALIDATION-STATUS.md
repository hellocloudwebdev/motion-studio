# Motion Studio 0.4 — Validation Status

**Branch:** `milestone/0.4-adobe-production-orchestration`  
**Pull request:** [#2](https://github.com/hellocloudwebdev/motion-studio/pull/2)  
**Code-validation commit:** `14e081482a2cfc07bb5fa1b0f2fc203892ab7e73`  
**CI:** [run 42384015420](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42384015420) — all 6 matrix jobs passed (Windows, macOS and Ubuntu on Node 24 and 26).  
**Status:** code-level validation is green; milestone acceptance is not complete.

## Implemented in the branch

- Approval-bound After Effects scene preview/apply workflow, live operation-catalog validation, project backup, save/readback and PNG frame proof.
- Approval-bound Premiere scene import/new-sequence workflow, backup, source identity checks, paginated sequence readback, save and optional Media Encoder export using an explicit `.epr` preset.
- High-level Motion Studio MCP tools; upstream Adobe tools remain scoped and unsafe scripting remains disabled.
- Per-host in-process mutation serialization, one-time approval lifecycle, reconciliation-required failure state and sanitized local run receipts.
- Mocked MCP integration tests and policy/unit tests have been authored.

## Validation gates still open

1. **Current-head CI:** the code commit `14e0814` passed all six Windows/macOS/Linux × Node 24/26 jobs. Re-run the matrix if any source code changes after this commit.
2. **Test execution:** unit tests and example validation/routing/compile scripts passed in the six-job matrix.
3. **Licensed Adobe host tests:** run the AE and Premiere workflows on a machine with licensed apps and the corresponding bridges installed; attach real project-save, readback, PNG proof and export/checksum receipts. Mocked MCP tests do not substitute for this.
4. **Installer acceptance:** test clean install, upgrade, repeat install and uninstall on a fresh supported Windows machine, and smoke-test macOS/Linux setup.
5. **End-to-end media acceptance:** render a real HyperFrames MP4, inspect it with FFprobe, and attach the renderer/QA receipt before claiming a complete production handoff.

## Exit decision

Do not merge 0.4 as a verified milestone, start 0.5, or mark the final architecture locked until the required CI and host/installer acceptance gates are satisfied. The absence of Adobe applications on the development machine is a validation constraint, not a reason to fabricate successful host receipts.

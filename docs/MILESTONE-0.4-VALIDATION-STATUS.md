# Motion Studio 0.4 — Validation Status

**Branch:** `milestone/0.4-adobe-production-orchestration`  
**Pull request:** [#2](https://github.com/hellocloudwebdev/motion-studio/pull/2)  
**Latest audited commit before this status note:** `193d658cb934829c564332be24b1d49eb612aa55`  
**Status:** implementation code is present; milestone validation is not complete.

## Implemented in the branch

- Approval-bound After Effects scene preview/apply workflow, live operation-catalog validation, project backup, save/readback and PNG frame proof.
- Approval-bound Premiere scene import/new-sequence workflow, backup, source identity checks, paginated sequence readback, save and optional Media Encoder export using an explicit `.epr` preset.
- High-level Motion Studio MCP tools; upstream Adobe tools remain scoped and unsafe scripting remains disabled.
- Per-host in-process mutation serialization, one-time approval lifecycle, reconciliation-required failure state and sanitized local run receipts.
- Mocked MCP integration tests and policy/unit tests have been authored.

## Validation gates still open

1. **Current-head CI:** the GitHub Actions run for the audited commit is `action_required` with zero jobs created. This is not a passing or failing test result; the workflow needs repository-owner approval before it can execute. Older successful checks are not evidence for the current head.
2. **Test execution:** run `npm install --no-audit --no-fund` and `npm test` plus the example validation/routing/compile scripts on the current PR head after CI approval.
3. **Licensed Adobe host tests:** run the AE and Premiere workflows on a machine with licensed apps and the corresponding bridges installed; attach real project-save, readback, PNG proof and export/checksum receipts.
4. **Installer acceptance:** test clean install, upgrade, repeat install and uninstall on a fresh supported Windows machine, and smoke-test macOS/Linux setup.
5. **End-to-end media acceptance:** render a real HyperFrames MP4, inspect it with FFprobe, and attach the renderer/QA receipt before claiming a complete production handoff.

## Exit decision

Do not merge 0.4 as a verified milestone, start 0.5, or mark the final architecture locked until the required CI and host/installer acceptance gates are satisfied. The absence of Adobe applications on the development machine is a validation constraint, not a reason to fabricate successful host receipts.

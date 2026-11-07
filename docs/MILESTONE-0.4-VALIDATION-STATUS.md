# Motion Studio 0.4 — Validation Status

**Branch:** `milestone/0.4-adobe-production-orchestration`  
**Pull request:** [#2](https://github.com/hellocloudwebdev/motion-studio/pull/2)  
**Current branch head:** `8c9ea569cbf1995e536eecdc9622fecf7a187820`  
**Latest PR validation run:** [42387710837](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42387710837) — Ubuntu and Windows checks are passing; macOS jobs are queued/running.  
**Prior full code/render matrix:** [run 42385125847](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42385125847) — six Windows/macOS/Ubuntu × Node 24/26 jobs and the real HyperFrames render passed.  
**Render evidence:** [MP4, QA frames and receipt artifact](https://github.com/hellocloudwebdev/motion-studio/actions/runs/42385125847/artifacts/13578804696).  
**Status:** code/render validation passed; isolated installer lifecycle is passing on Windows and Linux on the latest run, with macOS still pending. Licensed Adobe host acceptance and real user-profile host MCP startup remain open.

## Implemented in the branch

- Approval-bound After Effects scene preview/apply, live operation-catalog validation, project backup, save/readback and PNG frame proof.
- Approval-bound Premiere scene import/new-sequence workflow, backup, source identity checks, paginated sequence readback, save and optional Media Encoder export using an explicit `.epr` preset.
- High-level Motion Studio MCP tools; upstream Adobe tools remain scoped and unsafe scripting remains disabled.
- Per-host mutation serialization, one-time approval lifecycle, reconciliation-required failure state and sanitized local run receipts.
- HyperFrames compiler emits child compositions under `compositions/`, leaving one root project composition.
- Real HyperFrames render smoke: deterministic 640×360, 24 fps, 2-second H.264 MP4, independently inspected with FFprobe and QA frame extraction.
- Safe per-user installer/uninstaller: generated configs are marked, pre-existing Cursor/adapter configs are merged rather than overwritten, and uninstall removes only Motion Studio-owned entries while preserving unrelated user settings and secrets.

## Validation gates

1. **Unit and mocked MCP tests:** passed in the six-job Windows/macOS/Linux × Node 24/26 matrix on run 42385125847. Latest run 42387710837 has Ubuntu and Windows code jobs passing; macOS jobs are queued.
2. **Real HyperFrames render:** passed. FFprobe verified the video stream, 640×360 dimensions, 24 fps and 2-second duration; HyperFrames check and QA-frame extraction passed. The latest run's render job is green.
3. **Installer lifecycle:** the isolated test performs clean install, repeat install/in-place upgrade, host config merge, uninstall dry-run and confirmed uninstall while preserving unrelated user config. Windows and Ubuntu have passed on the latest validation run; macOS remains queued. This is disposable-home lifecycle validation, not an actual personal-profile Adobe host MCP startup test.
4. **Licensed After Effects host:** pending. Requires a licensed AE desktop app, live MCP bridge, saved project, post-apply readback and PNG proof.
5. **Licensed Premiere Pro host:** pending. Requires a licensed Premiere desktop app, CEP bridge, imported item/sequence readback, save/reopen and optional Media Encoder export with checksum/FFprobe evidence.
6. **Real user-profile MCP startup:** pending on a supported desktop host after installer configuration.

## Adobe host acceptance procedure

Follow [MILESTONE-0.4-LICENSED-HOST-ACCEPTANCE.md](MILESTONE-0.4-LICENSED-HOST-ACCEPTANCE.md). Use disposable projects, separate preview/approval for every mutation, and sanitized receipts. Mocked MCP tests, CLI success messages or screenshots without host readback do not close this gate.

## Environment constraints and exit decision

CI runners do not provide the user's licensed Adobe desktop applications or entitlements. The installer must not sign in, activate, purchase or bypass Adobe trust prompts. Real host evidence must come from a licensed Windows/macOS desktop with the bridges installed.

Do not claim 0.4 is production verified or declare final architecture lock until AE, Premiere and real host MCP startup receipts are attached. The user explicitly authorized starting 0.5 while these 0.4 host gates remain open; 0.5 is therefore tracked on a dependent branch/PR, not merged into `main`.

# CI (Motion Studio)

Workflow: `.github/workflows/ci.yml` (GitHub Actions). Branch: `main`.

> Status: the workflow has not been exercised on GitHub runners yet — it was
> authored and statically reviewed locally. The first `push` to `main`, any pull
> request, or a manual `workflow_dispatch` run is the real verification. Runner
> environment facts below were checked against the official
> [actions/runner-images](https://github.com/actions/runner-images) installed-software
> lists on **2026-11-13**.

## Triggers

- `push` to `main`
- `pull_request` (all branches)
- `workflow_dispatch` (manual run)

## Matrix

| OS              | Node |
| --------------- | ---- |
| ubuntu-latest   | 24   |
| windows-latest  | 24   |
| macos-latest    | 24   |

- `fail-fast: false` — one OS failing does not cancel the others.
- Node is pinned to the 24 major line because `engines` in `package.json` is
  `>=24.0.0`. Roadmap 4.1 asks for a "supported Node matrix"; add versions here
  as they become actually supported (keep the matrix equal to what the team can
  reproduce locally).

## Steps (per matrix leg)

1. `actions/checkout@v4`
2. `actions/setup-node@v4` — `node-version` from the matrix, `cache: npm`
   (requires the committed `package-lock.json`).
3. FFmpeg install, OS-conditional (see below).
4. Verify `ffmpeg -version` and `ffprobe -version` resolve on PATH — fail loud
   if the install did not take, instead of silently skipping media tests.
5. `npm ci --no-audit --no-fund` — reproducible install from the committed
   lockfile. (`--no-audit` only suppresses the implicit install-time audit; the
   explicit audit runs as its own step.)
6. `npm test` — runs `node --test` at the repo root; the default test-runner
   discovery walks all workspaces (`packages/*`, `apps/*`, `servers/*`),
   excluding `node_modules`.
7. `npm audit --omit=dev` with `continue-on-error: true` — **non-blocking,
   log-only**. See "Dependency audit" below.

## FFmpeg / FFprobe

The task assumption "windows-latest ships ffmpeg" was **checked and is false**,
as are the Linux/macOS equivalents. None of the current `*-latest` images list
FFmpeg in their installed software (verified 2026-11-13):

| Image                       | FFmpeg preinstalled |
| --------------------------- | ------------------- |
| Windows 2022 / Windows 2025 | No (Chocolatey 2.7.5 is preinstalled) |
| Ubuntu 24.04                | No |
| macOS 15 / macOS 26         | No |

Therefore the workflow installs FFmpeg explicitly on every leg:

- Linux: `sudo apt-get update && sudo apt-get install -y ffmpeg`
- macOS: `brew install ffmpeg`
- Windows: `choco install ffmpeg -y --no-progress`

The verify step also confirms `ffprobe`, which several packages
(`packages/ffmpeg`, `packages/render-manager`, `packages/media-derivatives`)
need for real-media fixture tests.

Notes:

- `ubuntu-latest` moved to Ubuntu 26.04 in November 2026 (runner-images
  announcement in the image readme); the `apt-get` step does not depend on the
  Ubuntu version.
- The test suite degrades gracefully without FFmpeg — for example
  `packages/render-manager/src/media-analysis.test.mjs:56`
  (`t.skip("FFmpeg/libx264 is unavailable on this runner.")`) and
  `packages/speech-adapter/src/fish-audio.test.mjs:95`. Installing FFmpeg keeps
  those fixture tests inside the CI signal instead of skipping them.

## What CI deliberately does NOT run

CI is a code-level gate. The following are **environment-gated on developer or
acceptance hosts** and are intentionally out of CI scope:

- **Blender** — not installed in CI. 3D rendering is gated on real hosts with
  Blender (the roadmap's 3D milestone records runtime evidence from an actual
  Blender 5.3 render; CI has no such gate).
- **Adobe After Effects / Premiere Pro / their MCP integrations** — user-installed,
  user-licensed software; never installed or activated by CI.
- **HyperFrames headless browser** — `scripts/install.mjs:206` runs
  `node <hyperframes-entry> browser ensure` as an *optional* host-setup step
  (it warns, not fails, if it cannot). CI does not run it: the affected tests
  skip cleanly, e.g. `packages/repair-executor/src/consistency-probe.test.mjs:87`
  (`t.skip('HyperFrames CLI or FFmpeg is not available on this runner.')`).
  If a milestone needs browser-backed coverage in CI, add an explicit
  `browser ensure` step and update this document.
- **Platform speech engines** — SAPI / `say` / `espeak` availability varies by
  host; those tests skip per the convention in
  `packages/speech-adapter/src/index.test.mjs:29`.
- **Delivery-time acceptance checks** (producer rights review, human review of
  the rendered master) — never automatable in CI.

## Dependency audit

- Command: `npm audit --omit=dev` (production dependency graph only).
- `continue-on-error: true`: findings appear in the job log and are tracked in
  the roadmap (e.g. "zero vulnerabilities at the 2026-11-11 update"), but they
  never fail the pipeline on their own.
- Nothing is uploaded or persisted from this step.
- Rationale: audit advisories do not map cleanly to "the build is broken";
  triaging them is a human decision recorded in the roadmap, not a CI gate.

## Lockfile policy

`package-lock.json` is committed, so CI uses `npm ci`. If the lockfile is ever
removed, switch the install step to `npm install` **and** remove the
`cache: npm` option from `setup-node` (it errors without a lockfile).

## The evidence-state rule

The roadmap defines an evidence ladder
(`docs/MASTER-REMAINING-IMPLEMENTATION-ROADMAP.md`):

> implemented → CI verified → runtime verified → production accepted

**A green CI run means exactly one thing: automated tests passed on the runner
matrix.** It does not mean:

- a renderer produced real frames (that is *runtime verified*, needs a host
  with the actual Blender/Adobe/HyperFrames browser environment);
- a milestone is production-accepted (needs rendered, independently verified
  delivery evidence and producer review);
- the suite covered the paths that skip in CI (Blender, Adobe, HyperFrames
  browser, platform speech engines — see "What CI deliberately does NOT run").

Mark work packages at the evidence level actually achieved (roadmap rule).
"CI verified ≠ runtime verified" is a hard distinction in this repo.

## Reproduce locally

```sh
npm ci --no-audit --no-fund
npm test
npm audit --omit=dev
node scripts/doctor.mjs   # host readiness: Node 24+, FFmpeg/FFprobe/Blender presence
```

## Known risks / assumptions

- Runner-image contents are a moving target (this check is dated 2026-11-13);
  the `Verify FFmpeg/FFprobe on PATH` step exists precisely so an image change
  fails loudly instead of silently skipping media tests.
- Actions are pinned to major tags (`@v4`); tighten to commit SHAs if the repo
  policy requires supply-chain pinning.
- History: the previously committed workflow also ran `validate:example`,
  `route:example` and `compile:example` and a Node 26 leg. The example pipeline
  steps and Node 26 are not part of the current CI scope; re-add them to the
  matrix only when they are meant to gate merges.

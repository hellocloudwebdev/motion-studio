# Motion Studio 0.5 — Evidence-driven visual QA and bounded repair

## Objective
Make the HyperFrames render pipeline evidence-driven: inspect the actual MP4, persist deterministic findings and repair proposals, and require explicit producer approval before treating a delivery as approved.

## Completed implementation
- [x] Render evidence evaluator connected to the render-manager receipt and CLI render quality gate.
- [x] FFmpeg black-frame, frozen-frame and audio-silence analysis with configurable thresholds.
- [x] Downsampled grayscale perceptual frame comparison and near-duplicate hold detection.
- [x] Optional Tesseract OCR with text bounding-box safe-area checks and lower-third/subtitle-region review notes.
- [x] Structured stable defects, severity, owner and retest metadata.
- [x] Deterministic scene/project repair proposals, bounded to a configurable maximum of three attempts, with escalation.
- [x] QA runs, repair history and explicit approvals persisted in an enriched Canonical Video IR copy without mutating the source project.
- [x] Opt-in visual-critic provider adapter; its findings are advisory and cannot override deterministic gates.
- [x] Real MP4 fixture integration test and CI FFmpeg installation on Linux, Windows and macOS.
- [x] CLI quality gate, OCR/audio strictness flags, and explicit qa-approve command.
- [x] Unit tests for parsers, media-analysis algorithms, QA persistence, approval semantics and critic contract.

## Runtime behavior
1. Render to MP4 and probe its stream metadata.
2. Extract representative frames and decode them.
3. Run FFmpeg black/freeze/silence detectors and perceptual frame sampling.
4. If Tesseract is installed, OCR sampled frames and inspect text bounds. Use --require-ocr to make OCR availability mandatory.
5. Evaluate deterministic checks. A failed gate writes a render manifest, QA report, repair plan and project-with-qa.json, then exits non-zero.
6. A passing run is not producer-approved automatically. Use motion-studio qa-approve project-with-qa.json --actor "Producer" to append an explicit approval record to a separate output file.

## CLI options
- --black-duration <seconds> default 0.25
- --freeze-duration <seconds> default 2
- --silence-duration <seconds> default 2.5
- --require-ocr fail if Tesseract is unavailable
- --no-ocr skip OCR
- --require-continuous-audio fail for a missing audio stream or detected silence
- --max-repair-attempts <0..3> default 2
- --repair-attempt <n> current bounded repair attempt

## Acceptance and limitations
- Deterministic media checks fail closed on detector execution errors.
- Black segments at clip boundaries are advisory because they may be intentional fades; interior black segments are blocking.
- Audio silence is advisory by default; strict continuous-audio mode makes it blocking. Silence is not universally an error in creative work.
- OCR is optional unless explicitly required. OCR safe-area findings are review findings, not a guarantee of correct reading order, spelling, contrast, subtitle synchronization or semantic correctness.
- Perceptual comparison is a low-resolution grayscale similarity heuristic; it complements rather than replaces the FFmpeg freeze detector and human review.
- The visual critic is a provider interface, not a bundled third-party model. No external visual-critic service is called unless the host supplies a provider.
- Repair plans are proposals. This milestone does not silently rewrite creative intent or autonomously execute arbitrary repair commands.
- CI validates synthetic MP4s across operating systems; licensed Adobe applications and the full interactive desktop render path require a real user workstation.

## Status
Implementation complete for the defined 0.5 scope. CI and real-workstation Adobe verification are external execution gates and must be observed before a production release.

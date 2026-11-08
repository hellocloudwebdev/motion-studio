# Milestone 1.2 — Production-grade HyperFrames + GSAP renderer

## Objective
Make HyperFrames + GSAP the deterministic primary 2D renderer for Motion Studio, with expressive frame-timed motion, data visualization, typography, composition and reproducible render artifacts.

## Implemented in the first 1.2 slice
- [x] Apply transforms (rotation and scale) from Canonical Video IR to layer CSS.
- [x] Support frame-based motion duration and delay, plus an allowlisted GSAP easing set.
- [x] Add motion presets: fade, fade-up/slide-up, slide-left, slide-right, zoom, rotate and none.
- [x] Add deterministic inline SVG bar and line charts from structured IR data.
- [x] Escape chart labels/titles and restrict chart color tokens.
- [x] Restrict CSS color, border and shadow values before writing inline style attributes.
- [x] Add tests for chart output, invalid chart data, escaping, motion timing and CSS injection attempts.

## Remaining 1.2 work
- [ ] Complete typography layout: auto-fit, line wrapping, font fallback/glyph coverage and overflow diagnostics.
- [ ] Add supported SVG/vector and grouped/composite layers.
- [ ] Add additional chart types (stacked/grouped bars, area, donut) with data-label collision handling.
- [ ] Add reusable transition presets and scene-level transition overlap semantics.
- [ ] Implement deterministic arbitrary-frame seek and verify rendered frame sampling against expected timeline positions.
- [ ] Add render caching, incremental scene render, cancellation/resume and resource-aware scheduling.
- [ ] Expand real render acceptance tests using installed HyperFrames/Chromium and actual FFmpeg output.
- [ ] Document supported layer capability matrix and explicit failure behavior.

## Renderer safety
- Never interpolate untrusted chart labels into executable markup.
- Keep SVG output generated from structured data; do not embed arbitrary supplied SVG markup.
- Sanitize CSS colors and constrained style properties before emitting HTML.
- Fail closed on malformed chart data or unsupported chart types.
- Preserve explicit warnings for layers routed to another engine.
- Do not claim runtime verification from compiler unit tests alone.

## Exit gate
A multi-scene, mixed typography/shape/chart/media 2D project compiles and renders deterministically through HyperFrames + GSAP; arbitrary-frame seeking, cache/resume and output QA pass on the supported runtime matrix.

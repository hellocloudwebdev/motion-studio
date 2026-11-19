import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseMediaAnalysisLogs, parseLoudnessLog, parseTesseractTsv, comparePerceptualFrames, analyzeRenderedMedia } from "./media-analysis.mjs";

test("parses FFmpeg black, freeze and silence events", () => {
  const result = parseMediaAnalysisLogs({
    black: "[blackdetect] black_start:2.0 black_end:3.0 black_duration:1.0",
    freeze: "[freezedetect] freeze_start:4.0 freeze_end:7.0 freeze_duration:3.0",
    silence: "[silencedetect] silence_start: 1.5 silence_end: 4.5 silence_duration: 3.0"
  });
  assert.equal(result.black[0].duration, 1);
  assert.equal(result.freeze[0].start, 4);
  assert.equal(result.silence[0].duration, 3);
});

test("parses FFmpeg loudness and true-peak measurements", () => {
  const result = parseLoudnessLog('input_i : -20.49 LUFS\n{\n  "input_i" : "-20.49",\n  "input_tp" : "-0.43",\n  "input_lra" : "4.40",\n  "input_thresh" : "-30.88"\n}');
  assert.deepEqual(result, { integratedLufs: -20.49, truePeakDbtp: -0.43, loudnessRangeLu: 4.4, thresholdLufs: -30.88 });
  assert.equal(parseLoudnessLog("no measurements"), null);
});

test("flags OCR text outside configured safe area and preserves subtitle words", () => {
  const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t2\t20\t100\t30\t90\tClipped";
  const result = parseTesseractTsv(tsv, { width: 1920, height: 1080, safeAreaPercent: 5 });
  assert.equal(result.words[0].text, "Clipped");
  assert.equal(result.findings[0].code, "OCR_TEXT_OUTSIDE_SAFE_AREA");
});

test("perceptual comparison detects repeated normalized frames", () => {
  const frame = Buffer.alloc(32 * 18, 80);
  const changed = Buffer.alloc(32 * 18, 200);
  const result = comparePerceptualFrames(Buffer.concat([frame, frame, frame, changed]), { threshold: 1, maxStaticFrames: 2 });
  assert.equal(result.sampleCount, 4);
  assert.equal(result.nearDuplicateRunDetected, true);
  assert.equal(result.maxNearDuplicateRunFrames, 2);
});

test("real MP4 fixture detects an interior black segment and audio silence when FFmpeg is available", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-studio-media-qa-"));
  const input = path.join(root, "fixture.mp4");
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "color=c=white:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input
  ];
  const child = spawn("ffmpeg", args, { shell: false, stdio: "ignore" });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
  if (code !== 0) { await rm(root, { recursive: true, force: true }); t.skip("FFmpeg/libx264 is unavailable on this runner."); return; }
  try {
    const result = await analyzeRenderedMedia({
      input, media: { hasAudio: true, durationSeconds: 4, width: 160, height: 90 },
      options: { ocr: false, freezeDurationSeconds: 3, silenceDurationSeconds: 1, perceptualMaxStaticSeconds: 10 }
    });
    assert.ok(result.findings.some(item => item.code === "BLACK_FRAME_SEGMENT" && item.severity === "high"));
    assert.ok(result.findings.some(item => item.code === "AUDIO_SILENCE_SEGMENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real audio analysis records loudness and flags an over-ceiling true peak", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-studio-loudness-"));
  const input = path.join(root, "tone.mp4");
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=160x90:r=10:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input];
  const child = spawn("ffmpeg", args, { shell: false, stdio: "ignore" });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
  if (code !== 0) { await rm(root, { recursive: true, force: true }); t.skip("FFmpeg/libx264 is unavailable on this runner."); return; }
  try {
    const result = await analyzeRenderedMedia({ input, media: { hasAudio: true, durationSeconds: 3, width: 160, height: 90 }, options: { ocr: false, freezeDurationSeconds: 4, silenceDurationSeconds: 4, perceptualMaxStaticSeconds: 4, truePeakMaxDbtp: -40 } });
    const measured = result.detectors.loudness.measurements;
    assert.ok(Number.isFinite(measured.integratedLufs));
    assert.ok(Number.isFinite(measured.truePeakDbtp));
    assert.ok(result.findings.some(item => item.code === "AUDIO_TRUE_PEAK_EXCEEDED"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// M1.7 QA depth: contrast, balance, clipping and A/V sync detectors.

test("a washed-out master flags CONTRAST_LOW and a luma skew flags BALANCE_SKEWED", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-studio-contrast-"));
  const input = path.join(root, "flat.mp4");
  // Nearly-flat grey for the first half, then a much darker second half:
  // low per-frame contrast in every sampled frame plus a strong first/second
  // half luma skew.
  const args = ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x808080:s=160x90:r=10:d=1.5",
    "-f", "lavfi", "-i", "color=c=0x181818:s=160x90:r=10:d=1.5",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,eq=brightness=0.06[v]",
    "-map", "[v]", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", input];
  const child = spawn("ffmpeg", args, { shell: false, stdio: "ignore" });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
  if (code !== 0) { await rm(root, { recursive: true, force: true }); t.skip("FFmpeg/libx264 is unavailable on this runner."); return; }
  try {
    const result = await analyzeRenderedMedia({ input, media: { hasAudio: false, durationSeconds: 3, width: 160, height: 90 }, options: { ocr: false, freezeDurationSeconds: 10, perceptualMaxStaticSeconds: 10, perceptualSampleFps: 0.5, maxLumaSkew: 0.3 } });
    assert.ok(result.findings.some(item => item.code === "CONTRAST_LOW"), "low contrast flagged: " + JSON.stringify(result.findings.map(f => f.code)));
    assert.ok(result.findings.some(item => item.code === "BALANCE_SKEWED"), "half/half luma skew flagged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a clipping audio master flags AUDIO_CLIPPING", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-studio-clip-"));
  const input = path.join(root, "clipping.mp4");
  // A sine boosted far past full scale clips hard; video is a simple color.
  const args = ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-filter_complex", "[1:a]volume=40db[a]", "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input];
  const child = spawn("ffmpeg", args, { shell: false, stdio: "ignore" });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
  if (code !== 0) { await rm(root, { recursive: true, force: true }); t.skip("FFmpeg/libx264 is unavailable on this runner."); return; }
  try {
    const result = await analyzeRenderedMedia({ input, media: { hasAudio: true, durationSeconds: 2, width: 160, height: 90 }, options: { ocr: false, freezeDurationSeconds: 10, silenceDurationSeconds: 10, perceptualMaxStaticSeconds: 10 } });
    assert.ok(result.findings.some(item => item.code === "AUDIO_CLIPPING"), "clipping flagged: " + JSON.stringify(result.findings.map(f => f.code)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an audio stream that drifts from the video duration flags AUDIO_SYNC_MISMATCH", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-studio-sync-"));
  const input = path.join(root, "sync.mp4");
  // 2 s video with a 3 s audio stream: a full second of drift.
  const args = ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input];
  const child = spawn("ffmpeg", args, { shell: false, stdio: "ignore" });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
  if (code !== 0) { await rm(root, { recursive: true, force: true }); t.skip("FFmpeg/libx264 is unavailable on this runner."); return; }
  try {
    const result = await analyzeRenderedMedia({ input, media: { hasAudio: true, durationSeconds: 2, width: 160, height: 90 }, options: { ocr: false, freezeDurationSeconds: 10, silenceDurationSeconds: 10, perceptualMaxStaticSeconds: 10, maxSyncDriftSeconds: 0.15 } });
    assert.ok(result.findings.some(item => item.code === "AUDIO_SYNC_MISMATCH"), "sync drift flagged: " + JSON.stringify(result.findings.map(f => f.code)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

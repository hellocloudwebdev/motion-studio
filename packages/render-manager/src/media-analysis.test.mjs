import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseMediaAnalysisLogs, parseTesseractTsv, comparePerceptualFrames, analyzeRenderedMedia } from "./media-analysis.mjs";

test("parses FFmpeg black, freeze and silence events", () => {
  const result = parseMediaAnalysisLogs({
    black: "[blackdetect] black_start:2.0 black_end:3.0 black_duration:1.0",
    freeze: "[freezedetect] freeze_start:4.0 freeze_end:7.0 freeze_duration:3.0",
    silence: "[silencedetect] silence_start:1.5 silence_end:4.5 silence_duration:3.0"
  });
  assert.equal(result.black[0].duration, 1);
  assert.equal(result.freeze[0].start, 4);
  assert.equal(result.silence[0].duration, 3);
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

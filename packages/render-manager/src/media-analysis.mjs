import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    const stdout = [], stderr = [];
    let settled = false;
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { if (!settled) { settled = true; resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }); } });
    child.once("close", code => { if (!settled) { settled = true; resolve({ code, stdout: Buffer.concat(stdout), stderr: stderr.join("") }); } });
  });
}

function eventsFromLog(text, startKey, endKey, durationKey) {
  const starts = [...text.matchAll(new RegExp(startKey + ":([0-9.]+)", "g"))].map(x => Number(x[1]));
  const ends = [...text.matchAll(new RegExp(endKey + ":([0-9.]+)", "g"))].map(x => Number(x[1]));
  const durations = [...text.matchAll(new RegExp(durationKey + ":([0-9.]+)", "g"))].map(x => Number(x[1]));
  return starts.map((start, i) => ({ start, end: ends[i] ?? null, duration: durations[i] ?? (ends[i] == null ? null : ends[i] - start) }));
}

export function parseMediaAnalysisLogs({ black = "", freeze = "", silence = "" } = {}) {
  return {
    black: eventsFromLog(black, "black_start", "black_end", "black_duration"),
    freeze: eventsFromLog(freeze, "freeze_start", "freeze_end", "freeze_duration"),
    silence: eventsFromLog(silence, "silence_start", "silence_end", "silence_duration")
  };
}

export function parseTesseractTsv(tsv, { width, height, safeAreaPercent = 5, minConfidence = 35 } = {}) {
  const lines = String(tsv || "").trim().split(/\r?\n/);
  if (lines.length < 2) return { words: [], findings: [] };
  const words = [], findings = [];
  const safe = Math.max(0, Math.min(25, Number(safeAreaPercent) || 0)) / 100;
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const text = cols.slice(11).join("\t").trim();
    const confidence = Number(cols[10]);
    const box = { left: Number(cols[6]), top: Number(cols[7]), width: Number(cols[8]), height: Number(cols[9]) };
    if (!text || !Number.isFinite(confidence) || confidence < minConfidence || !Object.values(box).every(Number.isFinite)) continue;
    words.push({ text, confidence, ...box });
    if (box.left < width * safe || box.top < height * safe || box.left + box.width > width * (1 - safe) || box.top + box.height > height * (1 - safe)) {
      findings.push({ code: "OCR_TEXT_OUTSIDE_SAFE_AREA", severity: "medium", text, box, message: "Recognized text extends beyond the configured safe area." });
    }
  }
  return { words, findings };
}

export function comparePerceptualFrames(raw, { width = 32, height = 18, threshold = 1.25, maxStaticFrames = 3 } = {}) {
  const frameBytes = width * height;
  const frameCount = Math.floor(raw.length / frameBytes);
  const pairs = [];
  let runStart = null, maxRun = 0;
  for (let i = 1; i < frameCount; i += 1) {
    let total = 0;
    const a = (i - 1) * frameBytes, b = i * frameBytes;
    for (let p = 0; p < frameBytes; p += 1) total += Math.abs(raw[a + p] - raw[b + p]);
    const meanAbsoluteDifference = total / frameBytes;
    const similar = meanAbsoluteDifference <= threshold;
    pairs.push({ fromFrame: i - 1, toFrame: i, meanAbsoluteDifference, similar });
    if (similar) {
      if (runStart === null) runStart = i - 1;
      maxRun = Math.max(maxRun, i - runStart);
    } else runStart = null;
  }
  return { sampleCount: frameCount, pairs, maxNearDuplicateRunFrames: maxRun, nearDuplicateRunDetected: maxRun >= maxStaticFrames && maxStaticFrames > 0 };
}

async function runFilter(input, filter, signal) {
  return run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-vf", filter, "-an", "-f", "null", "-"], { signal });
}
async function runAudioFilter(input, filter, signal) {
  return run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-af", filter, "-vn", "-f", "null", "-"], { signal });
}
async function extractPerceptualFrames(input, signal, sampleFps = 1) {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-vf", "fps=" + sampleFps + ",scale=32:18:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { signal });
}

export async function analyzeRenderedMedia({ input, media, frameEvidence = [], options = {}, signal } = {}) {
  if (!input || typeof input !== "string") throw new Error("Media analysis requires an input file path.");
  const thresholds = {
    blackDurationSeconds: Number(options.blackDurationSeconds ?? 0.25),
    freezeDurationSeconds: Number(options.freezeDurationSeconds ?? 2),
    silenceDurationSeconds: Number(options.silenceDurationSeconds ?? 2.5),
    silenceNoiseDb: Number(options.silenceNoiseDb ?? -50),
    perceptualThreshold: Number(options.perceptualThreshold ?? 1.25),
    perceptualMaxStaticSeconds: Number(options.perceptualMaxStaticSeconds ?? 3),
    safeAreaPercent: Number(options.safeAreaPercent ?? 5)
  };
  const black = await runFilter(input, "blackdetect=d=" + thresholds.blackDurationSeconds + ":pix_th=0.10", signal);
  const freeze = await runFilter(input, "freezedetect=n=-50dB:d=" + thresholds.freezeDurationSeconds, signal);
  if (black.code !== 0 || freeze.code !== 0) throw new Error("FFmpeg black/freeze analysis failed: " + [black.stderr, freeze.stderr].join("\n").slice(-3000));
  const blackEvents = eventsFromLog(black.stderr, "black_start", "black_end", "black_duration");
  const freezeEvents = eventsFromLog(freeze.stderr, "freeze_start", "freeze_end", "freeze_duration");
  let silenceEvents = [];
  if (media?.hasAudio) {
    const silence = await runAudioFilter(input, "silencedetect=noise=" + thresholds.silenceNoiseDb + "dB:d=" + thresholds.silenceDurationSeconds, signal);
    if (silence.code !== 0) throw new Error("FFmpeg audio-silence analysis failed: " + silence.stderr.slice(-2000));
    silenceEvents = eventsFromLog(silence.stderr, "silence_start", "silence_end", "silence_duration");
  }

  const sampleFps = Math.max(0.25, Math.min(2, Number(options.perceptualSampleFps ?? 1)));
  const rawFrames = await extractPerceptualFrames(input, signal, sampleFps);
  if (rawFrames.code !== 0) throw new Error("FFmpeg perceptual frame sampling failed: " + rawFrames.stderr.slice(-2000));
  const perceptual = comparePerceptualFrames(rawFrames.stdout, {
    width: 32, height: 18, threshold: thresholds.perceptualThreshold,
    maxStaticFrames: Math.max(1, Math.ceil(thresholds.perceptualMaxStaticSeconds * sampleFps))
  });
  const findings = [];
  for (const event of blackEvents) {
    const edge = event.start <= 0.1 || (event.end != null && media?.durationSeconds && media.durationSeconds - event.end <= 0.1);
    findings.push({ code: "BLACK_FRAME_SEGMENT", severity: edge ? "low" : "high", event, message: edge ? "Black frames occur at a clip boundary; review whether this is an intentional fade." : "Unexpected black frames occur inside the rendered clip." });
  }
  for (const event of freezeEvents) findings.push({ code: "FROZEN_FRAME_SEGMENT", severity: options.strictFreeze || (event.duration ?? 0) >= thresholds.freezeDurationSeconds * 2 ? "high" : "medium", event, message: "FFmpeg detected a frozen-frame segment; verify whether a static hold is intentional." });
  for (const event of silenceEvents) findings.push({ code: "AUDIO_SILENCE_SEGMENT", severity: options.requireContinuousAudio ? "high" : "medium", event, message: "An audio-silence segment exceeded the configured threshold." });
  if (options.requireContinuousAudio && !media?.hasAudio) findings.push({ code: "AUDIO_STREAM_MISSING", severity: "high", message: "Continuous audio was required but the rendered file has no audio stream." });
  if (perceptual.nearDuplicateRunDetected) findings.push({ code: "PERCEPTUAL_DUPLICATE_FRAMES", severity: "medium", event: { maxNearDuplicateRunFrames: perceptual.maxNearDuplicateRunFrames }, message: "Downsampled consecutive frames are perceptually near-identical for longer than the configured static-frame threshold." });

  let ocr = { available: false, skipped: true, words: [], findings: [], reason: "Tesseract OCR is not installed or not enabled." };
  if (options.ocr !== false) {
    const version = await run("tesseract", ["--version"], { signal });
    if (version.code === 0) {
      ocr = { available: true, skipped: false, words: [], findings: [] };
      for (const frame of frameEvidence) {
        if (!frame.decoded || !frame.path) continue;
        const result = await run("tesseract", [frame.path, "stdout", "tsv"], { signal });
        if (result.code !== 0) {
          ocr.findings.push({ code: "OCR_FRAME_FAILED", severity: options.requireOcr ? "high" : "low", message: "Tesseract could not inspect frame at " + frame.atSeconds + " seconds." });
          continue;
        }
        const parsed = parseTesseractTsv(result.stdout.toString("utf8"), {
          width: media.width, height: media.height, safeAreaPercent: thresholds.safeAreaPercent,
          minConfidence: Number(options.ocrMinConfidence ?? 35)
        });
        ocr.words.push(...parsed.words.map(word => ({ ...word, atSeconds: frame.atSeconds })));
        ocr.findings.push(...parsed.findings.map(finding => ({ ...finding, atSeconds: frame.atSeconds })));
      }
      ocr.findings.push(...ocr.words.filter(word => word.top + word.height > media.height * 0.82).map(word => ({
        code: "OCR_BOTTOM_TEXT_REVIEW", severity: "low", text: word.text, atSeconds: word.atSeconds,
        message: "Recognized text is in the lower subtitle region; verify subtitle safe-area and clipping manually."
      })));
    }
  }
  if (options.requireOcr && !ocr.available) ocr.findings.push({ code: "OCR_REQUIRED_UNAVAILABLE", severity: "high", message: "OCR was required but Tesseract is unavailable." });
  findings.push(...ocr.findings);
  const blocking = findings.some(item => item.severity === "critical" || item.severity === "high");
  return {
    version: 1, thresholds,
    detectors: { black: { exitCode: black.code, events: blackEvents }, freeze: { exitCode: freeze.code, events: freezeEvents }, silence: { skipped: !media?.hasAudio, events: silenceEvents }, perceptual, ocr },
    findings, passed: !blocking, analyzedAt: new Date().toISOString()
  };
}

// Integer-frame time math at evidence boundaries: frame rate stays a rational
// and seconds are converted to frames only when findings enter the QA stream.

export function fpsValue(fpsRational) {
  if (typeof fpsRational === "string") {
    const [numerator, denominator = "1"] = fpsRational.split("/");
    return fpsValue({ numerator: Number(numerator), denominator: Number(denominator) });
  }
  if (typeof fpsRational === "number") return Number.isFinite(fpsRational) && fpsRational > 0 ? fpsRational : 0;
  const numerator = Number(fpsRational?.numerator), denominator = Number(fpsRational?.denominator);
  return numerator > 0 && denominator > 0 ? numerator / denominator : 0;
}

// Float seconds x fps can land an ulp below an exact frame boundary (1.001s at
// 30000/1001 is exactly frame 30 in rational terms), so floor/ceil carry a tiny
// epsilon to cancel binary representation error.
const FRAME_EPSILON = 1e-9;

// Half-open integer frame range covering [start, end) seconds: floor of the
// start frame, ceil of the end frame, both clamped to at least frame 0. A
// missing or unknown end collapses to the single frame holding the instant.
export function secondsToFrameRange(seconds, fpsRational) {
  const fps = fpsValue(fpsRational);
  const startSeconds = seconds == null ? Number.NaN : Number(typeof seconds === "object" ? seconds.start : seconds);
  const endSeconds = seconds && typeof seconds === "object" ? Number(seconds.end) : Number.NaN;
  if (!(fps > 0) || !Number.isFinite(startSeconds)) return null;
  const startFrame = Math.max(0, Math.floor(startSeconds * fps + FRAME_EPSILON));
  const endFrame = seconds.end != null && Number.isFinite(endSeconds) ? Math.max(startFrame, Math.ceil(endSeconds * fps - FRAME_EPSILON)) : startFrame + 1;
  return { startFrame, endFrame };
}

// Scene starts are absolute: a declared startFrame, otherwise the cumulative
// sum of previous durations (same convention as project validation).
export function mapEventToScenes(eventStartFrame, eventEndFrame, scenes) {
  if (!Array.isArray(scenes)) return [];
  const start = Number(eventStartFrame), end = Number(eventEndFrame);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const sceneIds = [];
  let nextStart = 0;
  for (const scene of scenes) {
    const durationFrames = Number(scene?.durationFrames);
    const sceneStart = Number.isInteger(scene?.startFrame) && scene.startFrame >= 0 ? scene.startFrame : nextStart;
    if (!Number.isInteger(durationFrames) || durationFrames <= 0) continue;
    const sceneEnd = sceneStart + durationFrames;
    const hit = end > start ? start < sceneEnd && sceneStart < end : sceneStart <= start && start < sceneEnd;
    if (hit && typeof scene.id === "string" && scene.id) sceneIds.push(scene.id);
    nextStart = Math.max(nextStart, sceneEnd);
  }
  return sceneIds;
}

import { spawnSync } from 'node:child_process';

export function ffmpegAvailable() {
  try { return spawnSync('ffprobe', ['-version'], { stdio: 'ignore', shell: false }).status === 0; }
  catch { return false; }
}

// A real 64x48 RGB PNG (rendered once with ffmpeg, embedded as base64) used as
// a stand-in provider payload for OpenRouter image responses.
export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAZUlEQVR4nNXOMQ0AMAzAsEwKf8odiB5VjMBvaJM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4iZM4ifM6sPUBn7ABvXp+jBYAAAAASUVORK5CYII=';

import path from 'node:path';

function assertSafePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty path.');
  if (value.includes('\0')) throw new Error(label + ' contains a null byte.');
  return path.resolve(value);
}

export function buildTranscodePlan({ input, output, width, height, fps, videoCodec = 'libx264', audioCodec = 'aac', crf = 18 } = {}) {
  const source = assertSafePath(input, 'input');
  const target = assertSafePath(output, 'output');
  if (source === target) throw new Error('Input and output paths must differ.');
  if (![width, height, fps, crf].every(Number.isFinite) || width <= 0 || height <= 0 || fps <= 0 || crf < 0 || crf > 51) throw new Error('Invalid transcode settings.');
  const args = ['-hide_banner', '-y', '-i', source, '-vf', 'scale=' + Math.round(width) + ':' + Math.round(height) + ',fps=' + fps, '-c:v', videoCodec, '-crf', String(Math.round(crf)), '-c:a', audioCodec, '-movflags', '+faststart', target];
  return { executable: 'ffmpeg', args, input: source, output: target, expected: { width: Math.round(width), height: Math.round(height), fps, videoCodec, audioCodec } };
}

export function buildProbePlan({ input } = {}) {
  const source = assertSafePath(input, 'input');
  return { executable: 'ffprobe', args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], input: source };
}

export function parseProbeOutput(text) {
  const value = JSON.parse(text);
  const video = (value.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (value.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('No video stream found.');
  return { durationSeconds: Number(value.format?.duration || video.duration || 0), width: video.width, height: video.height, frameRate: video.avg_frame_rate || video.r_frame_rate, videoCodec: video.codec_name, audioCodec: audio?.codec_name || null, hasAudio: Boolean(audio) };
}

import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceOutput, probeImage, run, sha256File } from './runtime.mjs';

export const GRADIENT_IMAGE_TERMS = 'Locally synthesized, no third-party material';
export const DEFAULT_GRADIENT_PALETTE = ['#0E2A3A', '#14384E', '#4ADE80'];
const DIMENSION_RANGE = { min: 1, max: 8192 };
const PALETTE_RANGE = { min: 2, max: 8 };
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const expandHex = hex => (hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex);

// gradients' x0/y0/x1/y1 default to random positions, so an explicit seed is
// what makes renders reproducible for a fixed palette.
export function buildGradientImagePlan({ width, height, palette = DEFAULT_GRADIENT_PALETTE, seed = 42 } = {}) {
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < DIMENSION_RANGE.min || value > DIMENSION_RANGE.max) {
      throw new Error(name + ' must be an integer between ' + DIMENSION_RANGE.min + ' and ' + DIMENSION_RANGE.max + '.');
    }
  }
  if (!Array.isArray(palette) || palette.length < PALETTE_RANGE.min || palette.length > PALETTE_RANGE.max) {
    throw new Error('palette must contain ' + PALETTE_RANGE.min + '-' + PALETTE_RANGE.max + ' hex colors like #0E2A3A.');
  }
  const colors = palette.map(color => {
    if (typeof color !== 'string' || !HEX_COLOR.test(color.trim())) throw new Error('palette entries must be hex colors like #0E2A3A, received: ' + String(color) + '.');
    return '0x' + expandHex(color.trim()).slice(1).toUpperCase();
  });
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 32 - 1) throw new Error('seed must be an integer between 0 and 4294967295.');

  const source = 'gradients=s=' + width + 'x' + height +
    ':' + colors.map((color, index) => 'c' + index + '=' + color).join(':') +
    ':nb_colors=' + colors.length + ':seed=' + seed + ':rate=1';
  return {
    params: { width, height, palette: colors.map(color => '#' + color.slice(2)), seed },
    inputs: [['-f', 'lavfi', '-i', source]],
    audioArgs: [],
    videoArgs: ['-frames:v', '1'],
    extension: '.png'
  };
}

export async function generateGradientImage({ width, height, outputPath, projectRoot, palette, seed, signal, timeoutMs = 120_000 } = {}) {
  const plan = buildGradientImagePlan({ width, height, palette, seed });
  const { root, output, realDirectory } = await prepareWorkspaceOutput({ projectRoot, outputPath, label: 'Gradient image output' });
  const runId = process.pid + '-' + Date.now();
  const temp = path.join(realDirectory, '.asset-gradient-' + runId + plan.extension);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const input of plan.inputs) args.push(...input);
    args.push(...plan.videoArgs, temp);
    await run('ffmpeg', args, { cwd: realDirectory, signal, timeoutMs });
    const image = await probeImage(temp, { signal, label: 'ffmpeg-lavfi gradient image' });
    if (image.codec !== 'png' || image.width !== plan.params.width || image.height !== plan.params.height) {
      throw new Error('ffmpeg-lavfi gradient image verification failed: expected png ' + plan.params.width + 'x' + plan.params.height + ', FFprobe measured ' + image.codec + ' ' + image.width + 'x' + image.height + '.');
    }
    await rename(temp, output);
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('ffmpeg-lavfi gradient image output is empty.');
    return {
      provider: 'ffmpeg-lavfi',
      kind: 'image',
      variant: 'gradient',
      params: plan.params,
      projectRoot: root,
      output,
      sha256: await sha256File(output),
      byteSize: outputStat.size,
      image,
      verified: true,
      rightsStatus: 'generated',
      terms: GRADIENT_IMAGE_TERMS,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await rm(temp, { force: true });
  }
}

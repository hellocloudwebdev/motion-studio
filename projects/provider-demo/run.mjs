// P3.1 provider-demo: proves the provider-neutral asset production contracts by
// generating 3 SFX + 1 music bed + 1 gradient image with ffmpeg lavfi, attaching
// their receipts to a minimal Canonical Video IR and validating the result with
// @motion-studio/core. Locally synthesized assets are recorded as rightsStatus
// 'generated'; API providers (e.g. openrouter-image) would record 'unknown'.
// No API keys are used or required in this demo — OpenRouter image generation
// spends provider credit and is intentionally left out of the default run.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateSfx, generateMusicBed, generateGradientImage, attachProviderReceipt } from '../../packages/asset-providers/src/index.mjs';
import { validateProject } from '../../packages/core/src/index.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const ASSET_DIR = path.join(DEMO_ROOT, 'assets', 'provider');
const FRAME_RATE = 30;
const DURATION_FRAMES = 150;
const frames = seconds => Math.round(seconds * FRAME_RATE);

function formatKib(bytes) {
  return (bytes / 1024).toFixed(1) + ' KiB';
}

function printReceipt(receipt, elapsedMs) {
  const label = receipt.kind + (receipt.variant ? ' (' + receipt.variant + ')' : '');
  console.log(
    '  ' + label.padEnd(22) +
    ' ' + formatKib(receipt.byteSize).padStart(9) +
    '  ' + String(receipt.audio?.durationSeconds ?? receipt.image?.width + 'x' + receipt.image?.height).padEnd(11) +
    ' sha256:' + receipt.sha256.slice(0, 12) +
    '  ' + elapsedMs.toFixed(0).padStart(5) + ' ms'
  );
}

async function main() {
  const startedAt = performance.now();
  const projectPath = path.join(DEMO_ROOT, 'project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const baseValidation = validateProject(project);
  if (!baseValidation.valid) throw new Error('Base IR failed validation: ' + JSON.stringify(baseValidation.issues, null, 2));
  console.log('[provider-demo] base IR valid (' + path.basename(projectPath) + '): ' + baseValidation.summary.errors + ' errors, ' + baseValidation.summary.warnings + ' warnings');

  console.log('[provider-demo] generating assets with ffmpeg-lavfi into ' + path.relative(DEMO_ROOT, ASSET_DIR) + '/');
  const timings = {};
  const step = async (name, run) => {
    const at = performance.now();
    const receipt = await run();
    timings[name] = performance.now() - at;
    printReceipt(receipt, timings[name]);
    return receipt;
  };

  const whoosh = await step('sfx whoosh', () => generateSfx({
    kind: 'whoosh', durationSeconds: 1.5, params: { gain: 1.2 },
    projectRoot: DEMO_ROOT, outputPath: path.join(ASSET_DIR, 'sfx-whoosh.wav')
  }));
  const pop = await step('sfx pop', () => generateSfx({
    kind: 'pop', durationSeconds: 1,
    projectRoot: DEMO_ROOT, outputPath: path.join(ASSET_DIR, 'sfx-pop.wav')
  }));
  const impact = await step('sfx impact', () => generateSfx({
    kind: 'impact', durationSeconds: 1.2,
    projectRoot: DEMO_ROOT, outputPath: path.join(ASSET_DIR, 'sfx-impact.wav')
  }));
  const bed = await step('music-bed uplift', () => generateMusicBed({
    durationSeconds: 5, key: 'C', bpm: 96, mood: 'uplift',
    projectRoot: DEMO_ROOT, outputPath: path.join(ASSET_DIR, 'music-bed.wav')
  }));
  const gradient = await step('image gradient', () => generateGradientImage({
    width: 1920, height: 1080, palette: ['#0E2A3A', '#14384E', '#4ADE80'], seed: 42,
    projectRoot: DEMO_ROOT, outputPath: path.join(ASSET_DIR, 'gradient.png')
  }));

  console.log('[provider-demo] attaching provider receipts');
  let state = { project, report: null };
  for (const receipt of [bed, whoosh, pop, impact, gradient]) {
    state = attachProviderReceipt(state.project, receipt);
  }
  const byCapability = new Map(state.project.assets.map(asset => [asset.metadata.tags[1], asset]));
  const bedAsset = byCapability.get('music-bed');
  const gradientAsset = byCapability.get('image');
  const whooshAsset = state.project.assets.find(asset => asset.uri === 'assets/provider/sfx-whoosh.wav');
  const popAsset = state.project.assets.find(asset => asset.uri === 'assets/provider/sfx-pop.wav');
  const impactAsset = state.project.assets.find(asset => asset.uri === 'assets/provider/sfx-impact.wav');
  state.project.scenes[0].layers[0].assetId = gradientAsset.id;
  state.project.scenes[0].audioCues = [
    { assetId: bedAsset.id, offsetFrames: 0, durationFrames: DURATION_FRAMES, fadeInFrames: 15, fadeOutFrames: 30, volume: 0.8 },
    { assetId: whooshAsset.id, offsetFrames: 0, durationFrames: frames(1.5), fadeOutFrames: 10, volume: 1 },
    { assetId: popAsset.id, offsetFrames: 60, durationFrames: 20, volume: 0.9 },
    { assetId: impactAsset.id, offsetFrames: 96, durationFrames: 30, fadeOutFrames: 10, volume: 1 }
  ];

  const validation = validateProject(state.project);
  if (!validation.valid) throw new Error('Receipt-backed IR failed validation: ' + JSON.stringify(validation.issues, null, 2));
  const outputPath = path.join(DEMO_ROOT, 'project.with-providers.json');
  await writeFile(outputPath, JSON.stringify(state.project, null, 2) + '\n', 'utf8');

  console.log('[provider-demo] receipt-backed IR valid: ' + validation.summary.errors + ' errors, ' + validation.summary.warnings + ' warnings');
  console.log('[provider-demo] assets attached: ' + state.report.totalAssets + '; rights review required: ' + state.report.rightsReviewRequired.length + '; non-final assets: ' + state.report.nonFinalAssetIds.length);
  for (const asset of state.project.assets) {
    console.log(
      '  ' + asset.id.padEnd(28) +
      ' ' + asset.kind.padEnd(6) +
      ' ' + asset.uri.padEnd(24) +
      ' rights=' + asset.metadata.rightsStatus +
      ' final=' + asset.metadata.approvedForFinalUse +
      ' source=' + asset.metadata.source
    );
  }
  console.log('[provider-demo] wrote ' + path.basename(outputPath));
  console.log('[provider-demo] done in ' + (performance.now() - startedAt).toFixed(0) + ' ms total');
}

main().catch(error => {
  console.error('[provider-demo] failed:', error.message);
  process.exitCode = 1;
});

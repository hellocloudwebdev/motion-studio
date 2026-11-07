import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHyperFramesCli, renderHyperFramesProject } from '../packages/render-manager/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(await readFile(path.join(root, 'templates/ci-render-smoke/project.json'), 'utf8'));
const artifactRoot = path.resolve(process.env.MOTION_STUDIO_RENDER_DIR || path.join(root, 'artifacts/render-smoke'));
const engineRoot = path.join(artifactRoot, 'engine');
const outputRoot = path.join(artifactRoot, 'renders');

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });

const cli = await resolveHyperFramesCli(root);
const browser = spawnSync(process.execPath, [cli.entry, 'browser', 'ensure'], {
  cwd: root,
  env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' },
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false
});
if (browser.error || browser.status !== 0) {
  throw new Error('HyperFrames browser setup failed: ' + (browser.error?.message || browser.status));
}

const receipt = await renderHyperFramesProject(project, {
  projectRoot: root,
  sourceRoot: root,
  engineRoot,
  outputRoot,
  installRoot: root,
  quality: 'draft',
  workers: 1
});
if (!receipt.verified || !receipt.productionReady) {
  throw new Error('HyperFrames smoke render did not pass the output contract: ' + JSON.stringify(receipt.checks));
}
await writeFile(path.join(artifactRoot, 'ci-render-smoke-receipt.json'), JSON.stringify({
  milestone: '0.4',
  project: 'templates/ci-render-smoke/project.json',
  hyperframesVersion: receipt.hyperframesVersion,
  output: path.relative(root, receipt.output),
  bytes: receipt.bytes,
  media: receipt.media,
  checks: receipt.checks,
  frameEvidence: receipt.frameEvidence,
  verified: receipt.verified,
  productionReady: receipt.productionReady,
  completedAt: receipt.completedAt
}, null, 2) + '\n');
console.log(JSON.stringify({ output: receipt.output, bytes: receipt.bytes, media: receipt.media, checks: receipt.checks, productionReady: receipt.productionReady }, null, 2));

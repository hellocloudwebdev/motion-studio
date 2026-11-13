#!/usr/bin/env node
// P3.3 demo pipeline (deterministic, idempotent):
//  1. regenerate the 4s dynamic audio bed with ffmpeg lavfi (sine + scripted volume contour),
//  2. derive the frame-bound envelope via analyzeAudioEnvelope and store it as an asset,
//  3. compile the tiny IR through the HyperFrames adapter; the chart layer binds its bars
//     to the envelope via content.audioEnvelope,
//  4. prove at compile level that the emitted bar geometry equals the envelope-derived values.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAudioEnvelope, envelopeToChartData, runMediaCommand } from '../../packages/ffmpeg/src/index.mjs';
import { compileHyperFramesProject } from '../../packages/hyperframes-adapter/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const audioPath = path.join(root, 'assets', 'beat.wav');
const envelopePath = path.join(root, 'assets', 'envelope.json');
const fps = { numerator: 30, denominator: 1 };
const windowFrames = 2;

await mkdir(path.dirname(audioPath), { recursive: true });
await runMediaCommand('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', "sine=frequency=440:duration=4,volume=volume='0.05+0.85*abs(sin(2*PI*t))':eval=frame",
  '-c:a', 'pcm_s16le', '-ar', '48000', audioPath
]);

const envelope = await analyzeAudioEnvelope({ audioPath, fps, windowFrames });
await writeFile(envelopePath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');

const project = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
const { outputDir, manifest } = await compileHyperFramesProject(project, {
  outputDir: path.join(root, 'engines', 'hyperframes'),
  sourceRoot: root
});

const sceneHtml = await readFile(path.join(outputDir, 'scenes', 'scene-01.html'), 'utf8');
const heights = [...sceneHtml.matchAll(/<rect [^>]*height="([^"]+)"/g)].map(match => Number(match[1]));
const chart = envelopeToChartData(envelope);
const maxValue = Math.max(...chart.map(point => point.value));
const expectedHeights = chart.map(point => Math.abs(point.value) / maxValue * 426);
const barsMatch = heights.length === expectedHeights.length && heights.every((height, index) => Math.abs(height - expectedHeights[index]) <= 1e-6);
if (!barsMatch) throw new Error('Compiled bars do not match the audio envelope: ' + heights.length + ' bars emitted, ' + expectedHeights.length + ' expected from envelope.json.');
const labels = [...sceneHtml.matchAll(/<text [^>]*text-anchor="middle">([^<]*)<\/text>/g)].map(match => match[1]);

console.log(JSON.stringify({
  demo: 'audio-reactive-demo',
  proof: {
    audioBytes: (await stat(audioPath)).size,
    envelopeDurationFrames: envelope.durationFrames,
    envelopeWindowFrames: envelope.windowFrames,
    envelopeWindows: envelope.windows.length,
    barsEmitted: heights.length,
    barsMatchEnvelope: barsMatch,
    firstBarHeights: heights.slice(0, 5).map(height => Number(height.toFixed(2))),
    firstLabels: labels.slice(0, 5),
    compileWarnings: manifest.warnings.map(warning => warning.code),
    manifest: path.join(outputDir, 'render-manifest.json')
  }
}, null, 2));

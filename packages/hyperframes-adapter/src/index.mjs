import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../../core/src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GSAP = path.resolve(__dirname, '../../../node_modules/gsap/dist/gsap.min.js');
const safeId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'layer';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const cssString = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n;]/g, ' ');
const seconds = (frames, frameRate) => Number((frames * frameRate.denominator / frameRate.numerator).toFixed(6));
const isExternalUri = value => /^https?:\/\//i.test(value || '');

function cssFor(layer, fontFamily) {
  const style = layer.style || {};
  const x = Number(layer.transform?.x ?? layer.layout?.x ?? 0);
  const y = Number(layer.transform?.y ?? layer.layout?.y ?? 0);
  const width = Number(layer.transform?.width ?? layer.layout?.width ?? 800);
  const height = Number(layer.transform?.height ?? layer.layout?.height ?? 180);
  const styles = [
    'position:absolute', 'box-sizing:border-box',
    'left:' + x + 'px', 'top:' + y + 'px',
    'width:' + width + 'px', 'height:' + height + 'px',
    'opacity:' + Number(style.opacity ?? 1),
    'color:' + (style.color || '#ffffff'),
    'background:' + (style.backgroundColor || 'transparent'),
    'border-radius:' + (style.borderRadius ?? 0) + 'px',
    'padding:' + (style.padding ?? 0) + 'px',
    'display:flex', 'align-items:' + (style.verticalAlign === 'middle' ? 'center' : 'flex-start'),
    'justify-content:' + (style.textAlign === 'center' ? 'center' : style.textAlign === 'right' ? 'flex-end' : 'flex-start')
  ];
  if (layer.kind === 'text') {
    const typo = layer.typography || {};
    styles.push('font-family:"' + cssString(typo.family || fontFamily || 'Arial') + '"');
    styles.push('font-size:' + Number(typo.sizePx || 48) + 'px');
    styles.push('font-weight:' + (typo.weight || 700));
    styles.push('line-height:' + Number(typo.lineHeight || 1.08));
    styles.push('letter-spacing:' + Number(typo.tracking || 0) + 'px');
    styles.push('text-align:' + (typo.alignment || 'left'));
    styles.push('white-space:pre-wrap', 'overflow-wrap:anywhere');
  }
  if (layer.kind === 'image') styles.push('object-fit:' + (style.objectFit || 'cover'));
  return styles.join(';');
}

export async function compileHyperFramesProject(project, options = {}) {
  const validation = validateProject(project);
  if (!validation.valid) throw new Error('Cannot compile invalid Video IR: ' + JSON.stringify(validation.issues));
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), 'engines', 'hyperframes'));
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const requestedScenes = options.sceneIds ? new Set(options.sceneIds) : null;
  const selectedScenes = (project.scenes || []).filter(scene => !requestedScenes || requestedScenes.has(scene.id));
  if (!selectedScenes.length) throw new Error('No scenes selected for HyperFrames compilation.');
  const assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const copiedAssets = new Map();
  const warnings = [];
  await mkdir(path.join(outputDir, 'assets'), { recursive: true });
  await mkdir(path.join(outputDir, 'snapshots'), { recursive: true });
  await mkdir(path.join(outputDir, 'renders'), { recursive: true });

  async function resolveAsset(assetId) {
    if (!assetId) throw new Error('Media layer is missing assetId.');
    if (copiedAssets.has(assetId)) return copiedAssets.get(assetId);
    const asset = assets.get(assetId);
    if (!asset) throw new Error('Unknown assetId: ' + assetId);
    if (isExternalUri(asset.uri)) {
      warnings.push({ code: 'EXTERNAL_ASSET', assetId, message: 'External asset remains URL-linked; render is not fully offline-reproducible.' });
      copiedAssets.set(assetId, asset.uri);
      return asset.uri;
    }
    const raw = asset.uri?.startsWith('file://') ? fileURLToPath(asset.uri) : asset.uri;
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Asset ' + assetId + ' requires a local uri.');
    const sourcePath = path.resolve(sourceRoot, raw);
    const relative = path.relative(sourceRoot, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Asset path escapes the approved project root: ' + assetId);
    const extension = path.extname(sourcePath).toLowerCase();
    const destinationName = safeId(assetId) + extension;
    const destination = path.join(outputDir, 'assets', destinationName);
    await cp(sourcePath, destination);
    const uri = './assets/' + destinationName;
    copiedAssets.set(assetId, uri);
    return uri;
  }

  const sceneEntries = [];
  let cumulativeFrame = 0;
  for (const scene of selectedScenes) {
    const sceneHtml = [];
    for (let index = 0; index < (scene.layers || []).length; index += 1) {
      const layer = scene.layers[index];
      const hintedEngine = layer.engineHint;
      if (hintedEngine && !['auto', 'hyperframes'].includes(hintedEngine)) {
        warnings.push({ code: 'NON_HYPERFRAMES_LAYER', sceneId: scene.id, layerId: layer.id, engine: hintedEngine, message: 'Layer is routed to a different engine and is not emitted by the HyperFrames renderer.' });
        continue;
      }
      const layerId = safeId(layer.id);
      const startFrame = Number(layer.startFrame ?? 0);
      const durationFrames = Number(layer.durationFrames ?? Math.max(1, scene.durationFrames - startFrame));
      const attrs = ' id="' + layerId + '" class="clip ms-layer ms-' + esc(layer.kind) + '"' +
        ' data-start="' + seconds(startFrame, project.project.frameRate) + '"' +
        ' data-duration="' + seconds(durationFrames, project.project.frameRate) + '"' +
        ' data-track-index="' + Number(layer.trackIndex ?? index) + '"';
      const style = ' style="' + esc(cssFor(layer, project.brand?.fonts?.display || project.brand?.fonts?.body)) + '"';
      if (layer.kind === 'text') {
        const text = layer.content?.text ?? layer.content ?? layer.text ?? '';
        sceneHtml.push('<div' + attrs + style + '>' + esc(text) + '</div>');
      } else if (layer.kind === 'shape') {
        sceneHtml.push('<div' + attrs + style + ' aria-hidden="true"></div>');
      } else if (layer.kind === 'image') {
        const src = await resolveAsset(layer.assetId);
        sceneHtml.push('<img' + attrs + ' alt="' + esc(layer.content?.alt || '') + '" src="' + esc(src) + '"' + style + ' />');
      } else if (layer.kind === 'video') {
        const src = await resolveAsset(layer.assetId);
        sceneHtml.push('<video' + attrs + ' src="' + esc(src) + '" muted playsinline preload="auto" data-has-audio="false"></video>');
      } else if (layer.kind === 'audio') {
        const src = await resolveAsset(layer.assetId);
        sceneHtml.push('<audio' + attrs + ' src="' + esc(src) + '" preload="auto" data-volume="' + Number(layer.volume ?? 1) + '"></audio>');
      } else {
        warnings.push({ code: 'UNSUPPORTED_LAYER_KIND', sceneId: scene.id, layerId: layer.id, kind: layer.kind, message: 'Layer kind is not yet compiled by the HyperFrames adapter.' });
      }
    }
    const sceneDuration = seconds(scene.durationFrames, project.project.frameRate);
    const sceneId = safeId(scene.id);
    const compositionId = 'scene-' + sceneId;
    const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(scene.name) + '</title>\n<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101010} [data-composition-id]{position:relative;overflow:hidden;width:100%;height:100%;background:' + esc(project.brand?.colors?.background || '#101010') + '} .ms-layer{will-change:transform,opacity} .ms-image{object-fit:cover}</style>\n</head>\n<body>\n<div data-composition-id="' + compositionId + '" data-width="' + project.project.canvas.width + '" data-height="' + project.project.canvas.height + '" data-duration="' + sceneDuration + '">\n' + sceneHtml.join('\n') + '\n</div>\n<script src="./assets/gsap.min.js"></script>\n<script>\n(function(){\n const compositionId=' + JSON.stringify(compositionId) + ';\n const duration=' + sceneDuration + ';\n const tl=gsap.timeline({paused:true});\n document.querySelectorAll(".ms-layer").forEach(function(el){\n   const start=Number(el.dataset.start||0);\n   const motion=el.dataset.motion;\n   if(motion==="fade-up"){tl.fromTo(el,{opacity:0,y:40},{opacity:1,y:0,duration:0.65,ease:"power3.out"},start);}\n   else {tl.fromTo(el,{opacity:0},{opacity:1,duration:0.25,ease:"power1.out"},start);}\n });\n tl.set({}, {}, duration);\n window.__timelines=window.__timelines||{};\n window.__timelines[compositionId]=tl;\n})();\n</script>\n</body>\n</html>\n';
    await writeFile(path.join(outputDir, sceneId + '.html'), html, 'utf8');
    sceneEntries.push({ id: scene.id, name: scene.name, compositionId, durationFrames: scene.durationFrames, startFrame: cumulativeFrame, html: sceneId + '.html' });
    cumulativeFrame += scene.durationFrames;
  }

  await cp(DEFAULT_GSAP, path.join(outputDir, 'assets', 'gsap.min.js'));
  const manifest = {
    schemaVersion: '1.0.0',
    compiler: 'motion-studio-hyperframes-adapter',
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    frameRate: project.project.frameRate,
    canvas: project.project.canvas,
    totalDurationFrames: selectedScenes.reduce((sum, scene) => sum + scene.durationFrames, 0),
    scenes: sceneEntries,
    workerPolicy: { defaultWorkers: 1 },
    warnings
  };
  await writeFile(path.join(outputDir, 'render-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(outputDir, 'index.html'), '<!doctype html><html><body><main data-composition-id="motion-studio-root" data-width="' + project.project.canvas.width + '" data-height="' + project.project.canvas.height + '"><h1>Motion Studio render package</h1><p>Render individual scene HTML files from render-manifest.json using the scene-specific composition.</p></main></body></html>\n');
  return { outputDir, manifest, warnings };
}

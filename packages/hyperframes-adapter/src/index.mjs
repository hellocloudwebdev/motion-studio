import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject, estimateTextFit } from '../../core/src/index.mjs';
import { renderChartSvg } from './charts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GSAP = path.resolve(__dirname, '../../../node_modules/gsap/dist/gsap.min.js');
const safeId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'layer';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const cssString = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n;]/g, ' ');
const safeCssColor = (value, fallback = 'transparent') => {
  const candidate = String(value ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(candidate)) return candidate;
  if (/^(transparent|black|white|red|green|blue|yellow|orange|purple|gray|grey|silver|navy|teal|maroon)$/i.test(candidate)) return candidate;
  return /^(rgba?|hsla?)\([0-9.% ,+-]+\)$/i.test(candidate) ? candidate : fallback;
};
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
    'color:' + safeCssColor(style.color, '#ffffff'),
    'background:' + safeCssColor(style.backgroundColor, 'transparent'),
    'border-radius:' + Math.max(0, Number(style.borderRadius ?? 0)) + 'px',
    'padding:' + Math.max(0, Number(style.padding ?? 0)) + 'px',
    'display:flex', 'align-items:' + (style.verticalAlign === 'middle' ? 'center' : 'flex-start'),
    'justify-content:' + (style.textAlign === 'center' ? 'center' : style.textAlign === 'right' ? 'flex-end' : 'flex-start')
  ];
  const rotation = Number(layer.transform?.rotation ?? 0);
  const scale = Number(layer.transform?.scale ?? 1);
  if (Number.isFinite(rotation) && rotation !== 0) styles.push('transform:rotate(' + rotation + 'deg) scale(' + (Number.isFinite(scale) ? scale : 1) + ')');
  else if (Number.isFinite(scale) && scale !== 1) styles.push('transform:scale(' + scale + ')');
  if (typeof style.border === 'string' && /^\d+(?:\.\d+)?px solid #[0-9a-f]{3,8}$/i.test(style.border.trim())) styles.push('border:' + style.border.trim());
  if (typeof style.boxShadow === 'string' && /^-?[\d.]+px\s+-?[\d.]+px\s+[\d.]+px\s+#[0-9a-f]{3,8}$/i.test(style.boxShadow.trim())) styles.push('box-shadow:' + style.boxShadow.trim());
  if (style.gradient && Array.isArray(style.gradient.colors) && style.gradient.colors.length >= 2) {
    const colors = style.gradient.colors.slice(0, 4).map(color => safeCssColor(color, '#000000'));
    const angle = Number.isFinite(Number(style.gradient.angle)) ? Number(style.gradient.angle) : 135;
    styles.push('background:linear-gradient(' + angle + 'deg,' + colors.join(',') + ')');
  }
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
  if (['image', 'video'].includes(layer.kind)) styles.push('object-fit:' + (style.objectFit || 'cover'));
  return styles.join(';');
}

function layerMarkup(layer, scene, index, localStartFrame, globalStartFrame, frameRate, assetUri, placeholder, fontFamily) {
  const layerId = safeId(scene.id + '-' + layer.id);
  const durationFrames = Number(layer.durationFrames ?? Math.max(1, scene.durationFrames - localStartFrame));
  const motion = layer.motion?.preset || 'fade';
  const buildAttrs = startFrame => ' id="' + layerId + '" class="clip ms-layer ms-' + esc(layer.kind) + '"' +
    ' data-start="' + seconds(startFrame, frameRate) + '"' +
    ' data-duration="' + seconds(durationFrames, frameRate) + '"' +
    ' data-track-index="' + Number(layer.trackIndex ?? index) + '"' +
    ' data-motion="' + esc(motion) + '"' +
    ' data-motion-duration="' + seconds(Number(layer.motion?.durationFrames ?? 20), frameRate) + '"' +
    ' data-motion-delay="' + seconds(Number(layer.motion?.delayFrames ?? 0), frameRate) + '"' +
    ' data-motion-ease="' + esc(layer.motion?.easing || 'power3.out') + '"';
  const style = ' style="' + esc(cssFor(layer, fontFamily)) + '"';
  const content = layer.content?.text ?? layer.content ?? layer.text ?? '';
  let local = '', global = '';
  if (layer.kind === 'text') {
    local = '<div' + buildAttrs(localStartFrame) + style + '>' + esc(content) + '</div>';
    global = '<div' + buildAttrs(globalStartFrame + localStartFrame) + style + '>' + esc(content) + '</div>';
  } else if (layer.kind === 'shape') {
    local = '<div' + buildAttrs(localStartFrame) + style + ' aria-hidden="true"></div>';
    global = '<div' + buildAttrs(globalStartFrame + localStartFrame) + style + ' aria-hidden="true"></div>';
  } else if (layer.kind === 'image' && assetUri) {
    local = '<img' + buildAttrs(localStartFrame) + ' alt="' + esc(layer.content?.alt || '') + '" src="' + esc(assetUri) + '"' + style + ' />';
    global = '<img' + buildAttrs(globalStartFrame + localStartFrame) + ' alt="' + esc(layer.content?.alt || '') + '" src="' + esc(assetUri) + '"' + style + ' />';
  } else if (layer.kind === 'video' && assetUri) {
    local = '<video' + buildAttrs(localStartFrame) + ' src="' + esc(assetUri) + '" muted playsinline preload="auto" data-has-audio="false"' + style + '></video>';
    global = '<video' + buildAttrs(globalStartFrame + localStartFrame) + ' src="' + esc(assetUri) + '" muted playsinline preload="auto" data-has-audio="false"' + style + '></video>';
  } else if (layer.kind === 'audio' && assetUri) {
    const volume = Number(layer.volume ?? 1);
    local = '<audio' + buildAttrs(localStartFrame) + ' src="' + esc(assetUri) + '" preload="auto" data-volume="' + volume + '"></audio>';
    global = '<audio' + buildAttrs(globalStartFrame + localStartFrame) + ' src="' + esc(assetUri) + '" preload="auto" data-volume="' + volume + '"></audio>';
  } else if (layer.kind === 'chart') {
    const svg = renderChartSvg(layer.content, { color: layer.style?.color || layer.style?.fill });
    const chartStyle = ' style="' + esc(cssFor(layer, fontFamily) + ';display:block') + '"';
    local = '<div' + buildAttrs(localStartFrame) + chartStyle + '>' + svg + '</div>';
    global = '<div' + buildAttrs(globalStartFrame + localStartFrame) + chartStyle + '>' + svg + '</div>';
  } else if (placeholder) {
    const label = '[ASSET REQUIRED: ' + (layer.assetId || layer.kind) + ']';
    const placeholderStyle = ' style="position:absolute;left:40px;top:40px;padding:24px;background:#7f1d1d;color:#fff;font:700 28px Arial;width:calc(100% - 128px)"';
    const placeholderAttrs = startFrame => ' id="' + layerId + '" class="clip ms-layer ms-missing-asset" data-start="' + seconds(startFrame, frameRate) + '" data-duration="' + seconds(durationFrames, frameRate) + '" data-track-index="' + Number(layer.trackIndex ?? index) + '" data-motion="fade"';
    local = '<div' + placeholderAttrs(localStartFrame) + placeholderStyle + '>' + esc(label) + '</div>';
    global = '<div' + placeholderAttrs(globalStartFrame + localStartFrame) + placeholderStyle + '>' + esc(label) + '</div>';
  }
  return { local, global };
}

function documentHtml({ compositionId, title, width, height, duration, elements, background = '#101010', assetPrefix = './assets' }) {
  const script = '<script src="' + esc(assetPrefix) + '/gsap.min.js"></script>\n<script>\n(function(){\n' +
    ' const compositionId=' + JSON.stringify(compositionId) + ';\n' +
    ' const duration=' + Number(duration) + ';\n' +
    ' const tl=gsap.timeline({paused:true});\n' +
    ' document.querySelectorAll(".ms-layer").forEach(function(el){\n' +
    '   const start=Number(el.dataset.start||0)+Number(el.dataset.motionDelay||0);\n' +
    '   const motion=el.dataset.motion||"fade";\n' +
    '   const duration=Math.max(0.001,Number(el.dataset.motionDuration||0.667));\n' +
    '   const allowed=["none","power1.out","power2.out","power3.out","power4.out","back.out(1.7)","sine.out","circ.out"];\n' +
    '   const requested=el.dataset.motionEase||"power3.out";\n' +
    '   const ease=allowed.includes(requested)?requested:"power3.out";\n' +
    '   if(motion==="none"){tl.set(el,{opacity:1},start);}\n' +
    '   else if(motion==="fade-up"||motion==="slide-up"){tl.fromTo(el,{opacity:0,y:40},{opacity:1,y:0,duration,ease},start);}\n' +
    '   else if(motion==="slide-left"){tl.fromTo(el,{opacity:0,x:48},{opacity:1,x:0,duration,ease},start);}\n' +
    '   else if(motion==="slide-right"){tl.fromTo(el,{opacity:0,x:-48},{opacity:1,x:0,duration,ease},start);}\n' +
    '   else if(motion==="zoom"){tl.fromTo(el,{opacity:0,scale:0.85},{opacity:1,scale:1,duration,ease},start);}\n' +
    '   else if(motion==="rotate"){tl.fromTo(el,{opacity:0,rotation:-8},{opacity:1,rotation:0,duration,ease},start);}\n' +
    '   else {tl.fromTo(el,{opacity:0},{opacity:1,duration,ease},start);}\n' +
    ' });\n' +    ' const endMarker={value:0};\n' +
    ' tl.to(endMarker,{value:1,duration:duration,ease:"none"},0);\n' +
    ' window.__timelines=window.__timelines||{};\n' +
    ' window.__timelines[compositionId]=tl;\n' +
    '})();\n</script>';
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n' +
    '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:' + esc(background) + '} [data-composition-id]{position:relative;overflow:hidden;width:100%;height:100%;background:' + esc(background) + '} .ms-layer{will-change:transform,opacity} img,video{display:block}</style>\n</head>\n<body>\n' +
    '<div id="' + esc(compositionId) + '" data-composition-id="' + esc(compositionId) + '" data-start="0" data-duration="' + Number(duration) + '" data-width="' + Number(width) + '" data-height="' + Number(height) + '">\n' +
    elements.join('\n') + '\n</div>\n' + script + '\n</body>\n</html>\n';
}

export async function compileHyperFramesProject(project, options = {}) {
  const validation = validateProject(project);
  if (!validation.valid) throw new Error('Cannot compile invalid Video IR: ' + JSON.stringify(validation.issues));
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), 'engines', 'hyperframes'));
  const existingHtml = await readdir(outputDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const file of existingHtml) if (file.endsWith('.html') && file !== 'caption-skin.html') await rm(path.join(outputDir, file), { force: true });
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const requestedScenes = options.sceneIds ? new Set(options.sceneIds) : null;
  const selectedScenes = (project.scenes || []).filter(scene => !requestedScenes || requestedScenes.has(scene.id));
  if (!selectedScenes.length) throw new Error('No scenes selected for HyperFrames compilation.');
  const assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const copiedAssets = new Map();
  const warnings = [];
  await mkdir(path.join(outputDir, 'assets'), { recursive: true });
  await mkdir(path.join(outputDir, 'scenes'), { recursive: true });
  const existingScenes = await readdir(path.join(outputDir, 'scenes'));
  for (const file of existingScenes) if (file.endsWith('.html')) await rm(path.join(outputDir, 'scenes', file), { force: true });
  await mkdir(path.join(outputDir, 'snapshots'), { recursive: true });
  await mkdir(path.join(outputDir, 'renders'), { recursive: true });

  async function resolveAsset(assetId) {
    if (!assetId) return null;
    if (copiedAssets.has(assetId)) return copiedAssets.get(assetId);
    const asset = assets.get(assetId);
    if (!asset) {
      warnings.push({ code: 'ASSET_REFERENCE_MISSING', assetId, message: 'Asset reference is not defined in Canonical Video IR.' });
      return null;
    }
    if (/^https?:\/\//i.test(asset.uri || '')) {
      warnings.push({ code: 'EXTERNAL_ASSET', assetId, message: 'External asset URL is not offline-reproducible.' });
      copiedAssets.set(assetId, asset.uri);
      return asset.uri;
    }
    const raw = asset.uri?.startsWith('file://') ? fileURLToPath(asset.uri) : asset.uri;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const sourcePath = path.resolve(sourceRoot, raw);
    const relative = path.relative(sourceRoot, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Asset path escapes approved project root: ' + assetId);
    try {
      const info = await stat(sourcePath);
      if (!info.isFile()) throw new Error('Asset path is not a file: ' + assetId);
    } catch {
      warnings.push({ code: 'ASSET_FILE_MISSING', assetId, message: 'Local asset file is not present: ' + raw });
      return null;
    }
    const extension = path.extname(sourcePath).toLowerCase();
    const destinationName = safeId(assetId) + extension;
    const destination = path.join(outputDir, 'assets', destinationName);
    await cp(sourcePath, destination);
    const uri = './assets/' + destinationName;
    copiedAssets.set(assetId, uri);
    return uri;
  }

  const sceneEntries = [], rootMarkup = [];
  let cumulativeFrame = 0;
  const frameRate = project.project.frameRate;
  const displayFont = project.brand?.fonts?.display || project.brand?.fonts?.body || 'Arial';
  for (const scene of selectedScenes) {
    const sceneMarkup = [];
    for (let index = 0; index < (scene.layers || []).length; index += 1) {
      const layer = scene.layers[index];
      const hintedEngine = layer.engineHint;
      if (hintedEngine && !['auto', 'hyperframes'].includes(hintedEngine)) {
        warnings.push({ code: 'NON_HYPERFRAMES_LAYER', sceneId: scene.id, layerId: layer.id, engine: hintedEngine, message: 'Layer is routed to another engine and is excluded from this HTML renderer.' });
        continue;
      }
      if (!['text', 'shape', 'image', 'video', 'audio', 'chart'].includes(layer.kind)) {
        warnings.push({ code: 'UNSUPPORTED_LAYER_KIND', sceneId: scene.id, layerId: layer.id, kind: layer.kind, message: 'This layer kind is not yet emitted by the HyperFrames adapter.' });
        continue;
      }
      const localStartFrame = Number(layer.startFrame ?? 0);
      const globalStartFrame = cumulativeFrame;
      if (layer.kind === 'text') {
        const textValue = String(layer.content?.text ?? layer.content ?? layer.text ?? '');
        const typo = layer.typography || {};
        const boxWidth = Number(layer.transform?.width ?? layer.layout?.width ?? 800);
        const boxHeight = Number(layer.transform?.height ?? layer.layout?.height ?? 180);
        const fontSize = Number(typo.sizePx || 48);
        const fit = estimateTextFit({
          text: textValue,
          fontSizePx: fontSize,
          boxWidthPx: boxWidth,
          boxHeightPx: boxHeight,
          lineHeight: Number(typo.lineHeight || 1.08),
          maxLines: Number(typo.maxLines || Infinity)
        });
        if (!fit.fits) {
          const warning = { code: 'TEXT_OVERFLOW_ESTIMATED', sceneId: scene.id, layerId: layer.id, fontFamily: typo.family || displayFont, ...fit };
          warnings.push(warning);
          if (options.strictTypography === true) throw new Error('Text overflow estimated for layer ' + layer.id + ' in scene ' + scene.id + '.');
        }
        const safePercent = Number(project.project.canvas.safeAreaPercent ?? 5);
        const marginX = project.project.canvas.width * safePercent / 100;
        const marginY = project.project.canvas.height * safePercent / 100;
        const x = Number(layer.transform?.x ?? layer.layout?.x ?? 0);
        const y = Number(layer.transform?.y ?? layer.layout?.y ?? 0);
        if (x < marginX || y < marginY || x + boxWidth > project.project.canvas.width - marginX || y + boxHeight > project.project.canvas.height - marginY) {
          warnings.push({ code: 'TEXT_OUTSIDE_SAFE_AREA', sceneId: scene.id, layerId: layer.id, safeAreaPercent: safePercent, bounds: { x, y, width: boxWidth, height: boxHeight } });
        }
      }
      const assetUri = ['image', 'video', 'audio'].includes(layer.kind) ? await resolveAsset(layer.assetId) : null;
      const needsAsset = ['image', 'video', 'audio'].includes(layer.kind) && !assetUri;
      if (needsAsset && options.allowMissingAssetsAsPlaceholders === false) throw new Error('Required media asset is unavailable for layer ' + layer.id + ' in scene ' + scene.id + '.');
      const markup = layerMarkup(layer, scene, index, localStartFrame, globalStartFrame, frameRate, assetUri, needsAsset, displayFont);
      sceneMarkup.push(markup.local);
      rootMarkup.push(markup.global);
    }
    const sceneDuration = seconds(scene.durationFrames, frameRate);
    const sceneId = safeId(scene.id);
    const compositionId = 'scene-' + sceneId;
    const sceneDoc = documentHtml({
      compositionId, title: scene.name, width: project.project.canvas.width, height: project.project.canvas.height,
      duration: sceneDuration, elements: sceneMarkup.map(markup => markup.replaceAll('./assets/', '../assets/')), background: project.brand?.colors?.background || '#101010', assetPrefix: '../assets'
    });
    await writeFile(path.join(outputDir, 'scenes', sceneId + '.html'), sceneDoc, 'utf8');
    sceneEntries.push({ id: scene.id, name: scene.name, compositionId, durationFrames: scene.durationFrames, startFrame: cumulativeFrame, html: 'scenes/' + sceneId + '.html' });
    cumulativeFrame += scene.durationFrames;
  }

  await cp(DEFAULT_GSAP, path.join(outputDir, 'assets', 'gsap.min.js'));
  const rootDuration = seconds(cumulativeFrame, frameRate);
  const rootCompositionId = 'motion-studio-root';
  const rootDoc = documentHtml({
    compositionId: rootCompositionId, title: project.project.name, width: project.project.canvas.width, height: project.project.canvas.height,
    duration: rootDuration, elements: rootMarkup, background: project.brand?.colors?.background || '#101010'
  });
  await writeFile(path.join(outputDir, 'index.html'), rootDoc, 'utf8');
  const manifest = {
    schemaVersion: '1.0.0',
    compiler: 'motion-studio-hyperframes-adapter',
    projectId: project.project.id,
    projectRevision: project.project.revision || 1,
    rootCompositionId,
    frameRate,
    canvas: project.project.canvas,
    totalDurationFrames: cumulativeFrame,
    durationSeconds: rootDuration,
    entrypoint: 'index.html',
    scenes: sceneEntries,
    workerPolicy: { defaultWorkers: 1 },
    warnings
  };
  await writeFile(path.join(outputDir, 'render-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outputDir, manifest, warnings };
}

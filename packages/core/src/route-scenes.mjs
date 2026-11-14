const DEFAULT_CAPABILITIES = {
  'hyperframes': ['2d-motion', 'kinetic-typography', 'charts', 'shapes', 'web-layout', 'image', 'video-clip', 'audio-clip'],
  // Dual specialist stacks (2026-11-14): EffectCraft is the FREE default;
  // After Effects remains fully supported for licensed Adobe hosts. An
  // explicit engineHint picks one; inferred compositing work defaults to the
  // free engine so open-source setups never require a paid product.
  'effectcraft': ['compositing', 'vfx', 'tracking', 'roto', 'advanced-typography', 'motion-graphics'],
  'after-effects': ['compositing', 'vfx', 'tracking', 'roto', 'advanced-typography', 'motion-graphics'],
  'blender': ['3d', 'simulation', 'product-visualization', 'camera-animation', 'lighting'],
  'threejs': ['webgl', 'shader', 'procedural-3d', 'interactive-3d'],
  'ffmpeg': ['transcode', 'trim', 'scale', 'audio-mix', 'image-sequence', 'media-probe']
};

function inferEngine(layer) {
  if (layer.engineHint && layer.engineHint !== 'auto') return layer.engineHint;
  const caps = new Set(layer.requiredCapabilities || []);
  if (['transcode', 'trim', 'scale', 'image-sequence', 'media-probe'].some(x => caps.has(x))) return 'ffmpeg';
  if (layer.kind === '3d' || ['simulation', 'product-visualization', 'lighting'].some(x => caps.has(x))) return 'blender';
  if (['shader', 'webgl', 'procedural-3d', 'interactive-3d'].some(x => caps.has(x))) return 'threejs';
  if (['compositing', 'vfx', 'tracking', 'roto', 'advanced-typography'].some(x => caps.has(x))) return 'effectcraft';
  // Video and audio assets are timeline clips inside a HyperFrames composition;
  // FFmpeg is a media preprocessor/delivery engine, not the visual scene compositor.
  return 'hyperframes';
}

export function routeScenes(project, options = {}) {
  const availableEngines = new Set(options.availableEngines || Object.keys(DEFAULT_CAPABILITIES));
  const resourcePolicy = { maxWorkers: 1, draftPreview: true, ...options.resourcePolicy };
  // Editorial assembly defaults to the free FilmCraft engine; licensed Adobe
  // hosts set MOTION_STUDIO_EDITORIAL_ENGINE=premiere-pro (or pass the option)
  // to route assembly through Premiere Pro instead.
  const editorialEngine = options.editorialEngine || (process.env.MOTION_STUDIO_EDITORIAL_ENGINE === 'premiere-pro' ? 'premiere-pro' : 'filmcraft');
  const plans = [];
  const issues = [];
  for (const scene of project.scenes || []) {
    const grouped = new Map();
    for (const layer of scene.layers || []) {
      const engine = inferEngine(layer);
      const supported = DEFAULT_CAPABILITIES[engine] || [];
      const missingCapabilities = (layer.requiredCapabilities || []).filter(cap => !supported.includes(cap));
      if (!availableEngines.has(engine)) issues.push({ code: 'ENGINE_UNAVAILABLE', severity: 'error', sceneId: scene.id, layerId: layer.id, engine, message: `${engine} is required by layer ${layer.id}, but is not available in this runtime.` });
      if (missingCapabilities.length) issues.push({ code: 'CAPABILITY_UNMAPPED', severity: 'warning', sceneId: scene.id, layerId: layer.id, engine, missingCapabilities, message: `Engine capability map does not yet describe: ${missingCapabilities.join(', ')}.` });
      if (!grouped.has(engine)) grouped.set(engine, []);
      grouped.get(engine).push(layer.id);
    }
    const tasks = [...grouped.entries()].map(([engine, layerIds], index) => ({
      taskId: `${scene.id}:${engine}`, engine, layerIds, sequence: index,
      outputContract: scene.outputContract || { width: project.project.canvas.width, height: project.project.canvas.height, frameRate: project.project.frameRate, durationFrames: scene.durationFrames, colorSpace: project.project.colorSpace || 'Rec.709', alpha: false }
    }));
    plans.push({ sceneId: scene.id, name: scene.name, durationFrames: scene.durationFrames, tasks, assembly: { engine: editorialEngine, required: true }, delivery: { engine: 'ffmpeg', required: true } });
  }
  return { plans, issues, executionPolicy: { maxWorkers: Math.max(1, Math.min(4, Number(resourcePolicy.maxWorkers) || 1)), draftPreview: Boolean(resourcePolicy.draftPreview), resumeFromCheckpoint: resourcePolicy.resumeFromCheckpoint !== false }, summary: { scenes: plans.length, engineTasks: plans.reduce((n, x) => n + x.tasks.length, 0), blockedTasks: issues.filter(x => x.code === 'ENGINE_UNAVAILABLE').length } };
}

export const engineCapabilities = DEFAULT_CAPABILITIES;

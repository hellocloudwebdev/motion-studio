export function runProjectQA(project, routePlan = null) {
  const defects = [];
  const add = (category, severity, code, description, sceneId = null, repairOwner = 'executive-producer') => defects.push({
    defectId: `qa-${String(defects.length + 1).padStart(3, '0')}`, category, severity, code, description, sceneId,
    timeRangeFrames: null, repairOwner, retestRequired: true
  });
  if (!project || !project.project) return { passed: false, defects: [{ defectId: 'qa-001', category: 'structure', severity: 'critical', code: 'PROJECT_MISSING', description: 'No valid project object was provided.', sceneId: null, timeRangeFrames: null, repairOwner: 'executive-producer', retestRequired: true }] };
  for (const scene of project.scenes || []) for (const layer of scene.layers || []) {
    if (layer.kind === 'text') {
      if (!layer.typography?.family) add('typography', 'high', 'FONT_UNSPECIFIED', `Text layer ${layer.id} has no explicit font family. Silent font substitution is prohibited.`, scene.id, 'typography-specialist');
      if (layer.typography?.sizePx && layer.typography.sizePx < 18) add('typography', 'medium', 'TEXT_TOO_SMALL', `Text layer ${layer.id} is below the 18 px baseline footnote threshold at authored canvas size. Check legibility and intended output scale.`, scene.id, 'typography-specialist');
      if (layer.typography?.safeArea === false) add('typography', 'medium', 'TEXT_SAFE_AREA_DISABLED', `Text layer ${layer.id} is not constrained to the configured safe area.`, scene.id, 'typography-specialist');
    }
    if (layer.assetId && !(project.assets || []).some(a => a.id === layer.assetId)) add('assets', 'high', 'ASSET_REFERENCE_MISSING', `Layer ${layer.id} references missing asset ${layer.assetId}.`, scene.id, 'asset-producer');
  }
  if (routePlan) for (const issue of routePlan.issues || []) add('execution', issue.severity === 'error' ? 'critical' : 'low', issue.code, issue.message, issue.sceneId || null, 'engine-router');
  const critical = defects.some(x => x.severity === 'critical' || x.severity === 'high');
  return { passed: !critical, defects, summary: { total: defects.length, critical: defects.filter(x => x.severity === 'critical').length, high: defects.filter(x => x.severity === 'high').length, medium: defects.filter(x => x.severity === 'medium').length, low: defects.filter(x => x.severity === 'low').length } };
}

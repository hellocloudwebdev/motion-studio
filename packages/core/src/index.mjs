export { validateProject } from './validate-project.mjs';
export { routeScenes, engineCapabilities } from './route-scenes.mjs';
export { calculateTypeScale, estimateTextFit } from './typography.mjs';
export { runProjectQA } from './qa.mjs';
export { evaluateRenderEvidence, createRepairPlan } from './render-qa.mjs';
export { secondsToFrameRange, mapEventToScenes } from './frame-time.mjs';
export { persistQaRecord } from './qa-record.mjs';
export { runVisualCritic } from './visual-critic.mjs';
export {
  PatchError, projectIrSha256, MOTION_PRESETS, MOTION_EASINGS, OP_TYPES,
  GAIN_BUDGET_DB, DEFECT_REPAIR_REGISTRY, registryEntryFor, classifyDefects,
  createPatchFromDefects, validateRepairPatch, applyRepairPatch, computeRunGainBudgetUsed
} from './patch.mjs';

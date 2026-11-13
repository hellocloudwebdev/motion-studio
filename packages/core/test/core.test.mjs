import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProject, routeScenes, calculateTypeScale, estimateTextFit, runProjectQA } from '../src/index.mjs';
const project = JSON.parse(await readFile(new URL('../../../templates/startup-ad/project.json', import.meta.url), 'utf8'));
test('sample project validates', () => assert.equal(validateProject(project).valid, true));
test('router creates engine tasks and defaults to one worker', () => { const r=routeScenes(project); assert.ok(r.summary.engineTasks >= 3); assert.equal(r.executionPolicy.maxWorkers,1); });
// Every layer of the acceptance template hints 'hyperframes'; withholding that
// engine must block all of its scenes.
test('router blocks unavailable engines', () => assert.ok(routeScenes(project,{availableEngines:['ffmpeg']}).issues.some(x=>x.code==='ENGINE_UNAVAILABLE')));
test('type scale responds to canvas size', () => assert.ok(calculateTypeScale({width:1080,height:1920}).sizesPx.hero > calculateTypeScale({width:1080,height:1920}).sizesPx.caption));
test('text fit detects overflow', () => assert.equal(estimateTextFit({text:'Long headline that will not fit',fontSizePx:90,boxWidthPx:220,boxHeightPx:90,maxLines:1}).fits,false));
test('QA detects missing referenced assets', () => { const p=structuredClone(project); p.scenes[0].layers.push({id:'bad',kind:'image',assetId:'missing'}); assert.ok(runProjectQA(p).defects.some(x=>x.code==='ASSET_REFERENCE_MISSING')); });

// The acceptance template attaches no assets; the validator warning is exercised
// against an injected unattached reference so the contract stays covered.
test('project validation warns when a layer references an unattached asset', () => {
  const p = structuredClone(project);
  p.scenes[0].layers.push({ id: 'ghost-media', kind: 'image', assetId: 'missing-image' });
  const result = validateProject(p);
  assert.ok(result.issues.some(x => x.code === 'ASSET_REFERENCE_UNRESOLVED' && x.severity === 'warning'));
});
test('project validation rejects duplicate asset identities and malformed checksums', () => {
  const p = structuredClone(project);
  p.assets = [{ id: 'same', sha256: 'bad' }, { id: 'same' }];
  const result = validateProject(p);
  assert.ok(result.issues.some(x => x.code === 'DUPLICATE_ASSET_ID'));
  assert.ok(result.issues.some(x => x.code === 'INVALID_ASSET_CHECKSUM'));
});
// project.id and scene.id name filesystem workspaces and render artifacts, so
// they are constrained to the adapter's safeId charset before anything renders.
test('project and scene ids must match the filesystem-safe charset', () => {
  const escape = structuredClone(project);
  escape.project.id = '../../escape';
  const escapeResult = validateProject(escape);
  assert.equal(escapeResult.valid, false);
  assert.ok(escapeResult.issues.some(x => x.code === 'INVALID_PROJECT_ID' && x.severity === 'error'));
  const slashed = structuredClone(project);
  slashed.scenes[0].id = 'scene/1';
  const slashedResult = validateProject(slashed);
  assert.equal(slashedResult.valid, false);
  assert.ok(slashedResult.issues.some(x => x.code === 'INVALID_SCENE_ID' && x.severity === 'error'));
  const tooLong = structuredClone(project);
  tooLong.project.id = 'a'.repeat(81);
  assert.ok(validateProject(tooLong).issues.some(x => x.code === 'INVALID_PROJECT_ID'));
  const bounded = structuredClone(project);
  bounded.project.id = 'a'.repeat(80);
  bounded.scenes.forEach((scene, index) => { scene.id = 's'.repeat(79) + index; });
  assert.equal(validateProject(bounded).valid, true);
});

// Roadmap P3.3 multi-ratio delivery: several targets with distinct dimensions
// must validate, target ids must stay unique and filesystem-safe (they name
// delivery artifacts), and the optional per-target fit mode is enumerated.
test('delivery validation accepts multiple targets with distinct dimensions and fit modes', () => {
  const multi = structuredClone(project);
  multi.delivery.targets.push(
    { id: 'vertical-9x16', format: 'mp4', width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, fit: 'contain' },
    { id: 'square-1x1', format: 'mp4', width: 1080, height: 1080, frameRate: { numerator: 30, denominator: 1 }, fit: 'cover' }
  );
  assert.equal(validateProject(multi).valid, true);
});
test('delivery validation rejects duplicate, unsafe and missing target ids in multi-target projects', () => {
  const secondTarget = { id: 'vertical-9x16', format: 'mp4', width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 } };
  const duplicate = structuredClone(project);
  duplicate.delivery.targets.push(structuredClone(duplicate.delivery.targets[0]));
  assert.ok(validateProject(duplicate).issues.some(x => x.code === 'DUPLICATE_DELIVERY_TARGET_ID' && x.severity === 'error'));
  const unsafe = structuredClone(project);
  unsafe.delivery.targets.push(structuredClone(secondTarget));
  unsafe.delivery.targets[0].id = '../escape';
  const unsafeResult = validateProject(unsafe);
  assert.equal(unsafeResult.valid, false);
  assert.ok(unsafeResult.issues.some(x => x.code === 'INVALID_DELIVERY_TARGET_ID' && x.severity === 'error'));
  const unnamed = structuredClone(project);
  unnamed.delivery.targets.push(structuredClone(secondTarget));
  delete unnamed.delivery.targets[0].id;
  const unnamedResult = validateProject(unnamed);
  assert.equal(unnamedResult.valid, false);
  assert.ok(unnamedResult.issues.some(x => x.code === 'DELIVERY_TARGET_ID_REQUIRED' && x.severity === 'error'));
});
test('delivery validation keeps single-target projects id-optional for backward compatibility', () => {
  const unnamed = structuredClone(project);
  delete unnamed.delivery.targets[0].id;
  delete unnamed.delivery.primaryTargetId;
  const result = validateProject(unnamed);
  assert.equal(result.valid, true);
  assert.ok(!result.issues.some(x => String(x.code).startsWith('DELIVERY_TARGET_ID') || x.code === 'INVALID_DELIVERY_TARGET_ID' || x.code === 'DUPLICATE_DELIVERY_TARGET_ID'));
});
test('delivery validation rejects unknown fit modes and dangling primaryTargetId', () => {
  const badFit = structuredClone(project);
  badFit.delivery.targets[0].fit = 'crop';
  const badFitResult = validateProject(badFit);
  assert.equal(badFitResult.valid, false);
  assert.ok(badFitResult.issues.some(x => x.code === 'INVALID_DELIVERY_FIT' && x.severity === 'error'));
  const dangling = structuredClone(project);
  dangling.delivery.primaryTargetId = 'missing-target';
  const danglingResult = validateProject(dangling);
  assert.equal(danglingResult.valid, false);
  assert.ok(danglingResult.issues.some(x => x.code === 'INVALID_PRIMARY_TARGET_ID' && x.severity === 'error'));
});

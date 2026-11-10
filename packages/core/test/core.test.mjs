import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProject, routeScenes, calculateTypeScale, estimateTextFit, runProjectQA } from '../src/index.mjs';
const project = JSON.parse(await readFile(new URL('../../../templates/startup-ad/project.json', import.meta.url), 'utf8'));
test('sample project validates', () => assert.equal(validateProject(project).valid, true));
test('router creates engine tasks and defaults to one worker', () => { const r=routeScenes(project); assert.ok(r.summary.engineTasks >= 3); assert.equal(r.executionPolicy.maxWorkers,1); });
test('router blocks unavailable engines', () => assert.ok(routeScenes(project,{availableEngines:['hyperframes','ffmpeg']}).issues.some(x=>x.code==='ENGINE_UNAVAILABLE')));
test('type scale responds to canvas size', () => assert.ok(calculateTypeScale({width:1080,height:1920}).sizesPx.hero > calculateTypeScale({width:1080,height:1920}).sizesPx.caption));
test('text fit detects overflow', () => assert.equal(estimateTextFit({text:'Long headline that will not fit',fontSizePx:90,boxWidthPx:220,boxHeightPx:90,maxLines:1}).fits,false));
test('QA detects missing referenced assets', () => { const p=structuredClone(project); p.scenes[0].layers.push({id:'bad',kind:'image',assetId:'missing'}); assert.ok(runProjectQA(p).defects.some(x=>x.code==='ASSET_REFERENCE_MISSING')); });

test('project validation warns when a layer references an unattached asset', () => {
  const p = structuredClone(project);
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

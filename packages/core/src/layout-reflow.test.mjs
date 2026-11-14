import test from 'node:test';
import assert from 'node:assert/strict';
import { reflowProjectForTarget, auditReflowedLayout } from './layout-reflow.mjs';
import { runProjectQA, routeScenes, validateProject } from './index.mjs';

function projectFixture(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    project: { id: 'reflow-fixture', name: 'Reflow Fixture', objective: 'Verify per-target reflow.', frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080, pixelAspectRatio: 1, safeAreaPercent: 6 }, totalDurationFrames: 120, revision: 1, colorSpace: 'Rec.709' },
    creative: { concept: 'c', audience: 'a', message: 'See where your power goes', visualDirection: 'v' },
    brand: { colors: { background: '#10243a', accent: '#4ade80', text: '#ffffff' }, fonts: { display: 'Arial', body: 'Arial' } },
    assets: [],
    scenes: [
      {
        id: 'scene-01', name: 'Hook', startFrame: 0, durationFrames: 120, intent: 'Stop the scroll.',
        layers: [
          { id: 's1-bg', kind: 'shape', transform: { x: 0, y: 0, width: 1920, height: 1080 }, style: { backgroundColor: '#10243a' } },
          { id: 's1-accent', kind: 'shape', transform: { x: 173, y: 259, width: 250, height: 10 }, style: { backgroundColor: '#4ade80' } },
          { id: 's1-title', kind: 'text', content: { text: 'See where your power goes today' }, typography: { family: 'Arial', sizePx: 96, weight: 800, lineHeight: 1.02, maxLines: 3, safeArea: true }, transform: { x: 173, y: 335, width: 1574, height: 324 }, style: { color: '#ffffff' }, motion: { preset: 'float', durationFrames: 24 } },
          { id: 's1-support', kind: 'text', content: { text: 'Room-by-room energy visibility' }, typography: { family: 'Arial', sizePx: 34, lineHeight: 1.2, maxLines: 3, safeArea: true }, transform: { x: 173, y: 723, width: 1574, height: 173 }, style: { color: '#ffffff' } }
        ]
      }
    ],
    audio: { tracks: [] },
    captions: [{ id: 'cap-1', startFrame: 0, endFrame: 120, text: 'See where your power goes.' }],
    delivery: { targets: [{ id: 'master-16x9', format: 'mp4', width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }] },
    ...overrides
  };
}

test('reflow keeps the master layout untouched for a same-aspect target', () => {
  const { project, changes, reflowed } = reflowProjectForTarget(projectFixture(), { width: 1920, height: 1080 });
  assert.equal(reflowed, false);
  assert.deepEqual(changes, []);
  assert.equal(project.project.canvas.width, 1920);
  assert.equal(project.scenes[0].layers[2].transform.x, 173);
});

test('reflow to 9:16 refills the background, rescales type and clamps into the safe area', () => {
  const source = projectFixture();
  const { project, changes, reflowed } = reflowProjectForTarget(source, { width: 1080, height: 1920 });
  assert.equal(reflowed, true);
  assert.equal(project.project.canvas.width, 1080);
  assert.equal(project.project.canvas.height, 1920);
  assert.equal(project.project.canvas.safeAreaPercent, 6);
  const bounds = { marginX: 1080 * 0.06, marginY: 1920 * 0.06 };
  // Background refills the target canvas exactly.
  const background = project.scenes[0].layers[0];
  assert.deepEqual(background.transform, { x: 0, y: 0, width: 1080, height: 1920 });
  // Text takes the horizontal space of the target and rescales uniformly
  // (uniform scale = min(1080/1920, 1920/1080) = 0.5625 → 96 px → 54 px).
  const title = project.scenes[0].layers[2];
  assert.equal(title.typography.sizePx, 54);
  assert.ok(title.transform.width <= 1080 - 2 * bounds.marginX, 'text box fits the safe area width');
  assert.ok(title.transform.x >= bounds.marginX && title.transform.x + title.transform.width <= 1080 - bounds.marginX, 'text box clamped inside the safe area');
  assert.ok(title.transform.y >= bounds.marginY && title.transform.y + title.transform.height <= 1920 - bounds.marginY);
  // The accent shape scales uniformly without distortion.
  const accent = project.scenes[0].layers[1];
  assert.equal(accent.transform.width, Math.round(250 * 0.5625));
  assert.equal(accent.transform.height, Math.round(10 * 0.5625));
  // Captions, timing, motion and duration are untouched by the layout pass.
  assert.equal(project.project.totalDurationFrames, 120);
  assert.deepEqual(project.captions, source.captions);
  assert.equal(project.scenes[0].layers[2].motion.preset, 'float');
  assert.ok(changes.length >= 3, 'the change record covers every moved layer');
  for (const change of changes) {
    assert.ok(change.sceneId && change.layerId);
    assert.ok(change.from && change.to);
  }
});

test('reflowed IR passes canonical validation and deterministic QA cleanly', () => {
  const { project } = reflowProjectForTarget(projectFixture(), { width: 1080, height: 1920 });
  const validation = validateProject(project);
  assert.equal(validation.valid, true, 'reflowed IR validates: ' + JSON.stringify(validation.issues?.slice(0, 3)));
  const qa = runProjectQA(project, routeScenes(project));
  const blockers = qa.defects.filter(defect => ['critical', 'high'].includes(defect.severity));
  assert.deepEqual(blockers, [], 'no critical/high defects on the reflowed IR: ' + JSON.stringify(blockers.slice(0, 3)));
});

test('reflow never produces sub-18 px text even for extreme downscale', () => {
  const { project } = reflowProjectForTarget(projectFixture(), { width: 480, height: 270 });
  const sizes = project.scenes[0].layers.filter(layer => layer.kind === 'text').map(layer => layer.typography.sizePx);
  for (const size of sizes) assert.ok(size >= 18, 'reflowed text size ' + size + ' must stay >= 18 px');
  const audit = auditReflowedLayout(project);
  assert.equal(audit.passed, true, 'audit passes: ' + JSON.stringify(audit.findings.slice(0, 2)));
});

test('audit reports a genuinely overflowing text layer', () => {
  const project = projectFixture();
  project.scenes[0].layers[2].content.text = 'An enormously long headline that cannot possibly wrap into the available box height at this size without spilling over every boundary';
  project.scenes[0].layers[2].transform.height = 60;
  const audit = auditReflowedLayout(project);
  const overflow = audit.findings.find(finding => finding.code === 'REFLOW_TEXT_OVERFLOW');
  assert.ok(overflow, 'expected an overflow finding');
  assert.equal(overflow.layerId, 's1-title');
  assert.equal(overflow.severity, 'medium');
  assert.equal(audit.passed, false, 'a real overflow fails the audit; the variant renderer throws on it');
});

test('reflow rejects invalid target dimensions and missing canvases', () => {
  assert.throws(() => reflowProjectForTarget(projectFixture(), { width: 0, height: 1080 }), /positive integer/);
  assert.throws(() => reflowProjectForTarget(projectFixture(), { width: 1080.5, height: 1920 }), /positive integer/);
  const broken = projectFixture();
  delete broken.project.canvas;
  assert.throws(() => reflowProjectForTarget(broken, { width: 1080, height: 1920 }), /canvas/);
});

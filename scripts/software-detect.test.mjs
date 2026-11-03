import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAdobeApplications } from './software-detect.mjs';

test('reports Adobe products missing and preserves user action guidance', () => {
  const result = detectAdobeApplications({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: () => false });
  assert.equal(result.creativeCloud.installed, false);
  assert.equal(result.afterEffects.installed, false);
  assert.equal(result.premierePro.installed, false);
  assert.equal(result.userActionsRequired.length, 3);
});

test('recognizes supported macOS After Effects and Premiere installations', () => {
  const installed = new Set([
    '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
    '/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app',
    '/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app'
  ]);
  const result = detectAdobeApplications({ platform: 'darwin', exists: value => installed.has(value) });
  assert.equal(result.afterEffects.version, 2026);
  assert.equal(result.premierePro.version, 2025);
  assert.equal(result.creativeCloud.installed, true);
});

test('does not claim Adobe desktop apps on Linux', () => {
  const result = detectAdobeApplications({ platform: 'linux' });
  assert.equal(result.supported, false);
  assert.equal(result.afterEffects.installed, false);
});

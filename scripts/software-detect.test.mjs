import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAdobeApplications } from './software-detect.mjs';

test('reports Adobe products missing and preserves user action guidance', () => {
  const result = detectAdobeApplications({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: () => false
  });
  assert.equal(result.creativeCloud.installed, false);
  assert.equal(result.afterEffects.installed, false);
  assert.equal(result.premierePro.installed, false);
  assert.equal(result.userActionsRequired.length, 3);
});

test('detects macOS app paths correctly even when tests execute on Windows', () => {
  const installed = new Set([
    '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
    '/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app',
    '/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app'
  ]);
  const result = detectAdobeApplications({
    platform: 'darwin',
    exists: value => installed.has(value),
    versionOf: value => value.includes('Premiere') ? '25.6.0' : '26.0.0'
  });
  assert.equal(result.afterEffects.productYear, 2026);
  assert.equal(result.premierePro.productYear, 2025);
  assert.equal(result.premierePro.version, '25.6.0');
  assert.equal(result.premierePro.uxpCompatible, true);
  assert.equal(result.creativeCloud.installed, true);
});

test('does not mark Premiere 25.5 as UXP-compatible', () => {
  const installed = new Set(['/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app']);
  const result = detectAdobeApplications({
    platform: 'darwin',
    exists: value => installed.has(value),
    versionOf: () => '25.5.0'
  });
  assert.equal(result.premierePro.uxpCompatible, false);
});

test('does not assume the UXP version from the product folder year', () => {
  const installed = new Set(['/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app']);
  const result = detectAdobeApplications({
    platform: 'darwin',
    exists: value => installed.has(value),
    versionOf: () => null
  });
  assert.equal(result.premierePro.productYear, 2025);
  assert.equal(result.premierePro.uxpCompatible, null);
});

test('does not claim Adobe desktop apps on Linux', () => {
  const result = detectAdobeApplications({ platform: 'linux' });
  assert.equal(result.supported, false);
  assert.equal(result.afterEffects.installed, false);
  assert.equal(result.premierePro.uxpCompatible, false);
});

import path from 'node:path';
import { existsSync } from 'node:fs';

const AE_YEARS = [2026, 2025, 2024];
const PR_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020];

export function detectAdobeApplications({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'linux') return {
    supported: false,
    creativeCloud: { installed: false, path: null },
    afterEffects: { installed: false, version: null, path: null },
    premierePro: { installed: false, version: null, path: null },
    mediaEncoder: { installed: false, version: null, path: null },
    note: 'Adobe desktop creative applications are not supported by this Linux installer target.'
  };
  const roots = platform === 'win32'
    ? [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
    : ['/Applications'];
  const ccCandidates = platform === 'win32'
    ? roots.map(root => path.join(root, 'Adobe', 'Adobe Creative Cloud', 'ACC', 'Creative Cloud.exe'))
    : ['/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app'];
  const choose = candidates => candidates.find(candidate => exists(candidate)) || null;

  const aeCandidates = [];
  const prCandidates = [];
  const meCandidates = [];
  for (const root of roots) {
    for (const year of AE_YEARS) {
      if (platform === 'win32') aeCandidates.push(path.join(root, 'Adobe', 'Adobe After Effects ' + year, 'Support Files', 'AfterFX.exe'));
      else aeCandidates.push(path.join('/Applications', 'Adobe After Effects ' + year, 'Adobe After Effects ' + year + '.app'));
    }
    for (const year of PR_YEARS) {
      if (platform === 'win32') {
        prCandidates.push(path.join(root, 'Adobe', 'Adobe Premiere Pro ' + year, 'Adobe Premiere Pro.exe'));
        meCandidates.push(path.join(root, 'Adobe', 'Adobe Media Encoder ' + year, 'Adobe Media Encoder.exe'));
      } else {
        prCandidates.push(path.join('/Applications', 'Adobe Premiere Pro ' + year, 'Adobe Premiere Pro ' + year + '.app'));
        meCandidates.push(path.join('/Applications', 'Adobe Media Encoder ' + year, 'Adobe Media Encoder ' + year + '.app'));
      }
    }
  }
  const ae = choose(aeCandidates), premiere = choose(prCandidates), mediaEncoder = choose(meCandidates), cc = choose(ccCandidates);
  const yearFromPath = (value, pattern) => value ? Number(value.match(pattern)?.[1] || 0) : null;
  return {
    supported: true,
    creativeCloud: { installed: Boolean(cc), path: cc },
    afterEffects: { installed: Boolean(ae), version: yearFromPath(ae, /After Effects (20\d{2})/), path: ae },
    premierePro: { installed: Boolean(premiere), version: yearFromPath(premiere, /Premiere Pro (20\d{2})/), path: premiere },
    mediaEncoder: { installed: Boolean(mediaEncoder), version: yearFromPath(mediaEncoder, /Media Encoder (20\d{2})/), path: mediaEncoder },
    userActionsRequired: [!cc && 'install Creative Cloud Desktop and sign in', !ae && 'install Adobe After Effects from Creative Cloud', !premiere && 'install Adobe Premiere Pro from Creative Cloud'].filter(Boolean)
  };
}

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const AE_YEARS = [2026, 2025, 2024];
const PR_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020];

function readInstalledVersion(applicationPath, platform) {
  if (!applicationPath) return null;
  try {
    if (platform === 'win32') {
      const escaped = applicationPath.replaceAll("'", "''");
      return execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "(Get-Item -LiteralPath '" + escaped + "').VersionInfo.ProductVersion"
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    }
    if (platform === 'darwin') {
      const plist = readFileSync(path.posix.join(applicationPath, 'Contents', 'Info.plist'), 'utf8');
      return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || null;
    }
  } catch {}
  return null;
}

function isPremiereUxpCompatible(version) {
  if (typeof version !== 'string') return null;
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > 25 || (major === 25 && minor >= 6);
}

export function detectAdobeApplications({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  versionOf = readInstalledVersion
} = {}) {
  if (platform === 'linux') return {
    supported: false,
    creativeCloud: { installed: false, path: null },
    afterEffects: { installed: false, version: null, productYear: null, path: null },
    premierePro: { installed: false, version: null, productYear: null, uxpCompatible: false, path: null },
    mediaEncoder: { installed: false, version: null, productYear: null, path: null },
    note: 'Adobe desktop creative applications are not supported by this Linux installer target.'
  };

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const roots = platform === 'win32'
    ? [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
    : ['/Applications'];
  const ccCandidates = platform === 'win32'
    ? roots.map(root => join(root, 'Adobe', 'Adobe Creative Cloud', 'ACC', 'Creative Cloud.exe'))
    : ['/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app'];
  const choose = candidates => candidates.find(candidate => exists(candidate)) || null;

  const aeCandidates = [], prCandidates = [], meCandidates = [];
  for (const root of roots) {
    for (const year of AE_YEARS) {
      if (platform === 'win32') aeCandidates.push(join(root, 'Adobe', 'Adobe After Effects ' + year, 'Support Files', 'AfterFX.exe'));
      else aeCandidates.push(join('/Applications', 'Adobe After Effects ' + year, 'Adobe After Effects ' + year + '.app'));
    }
    for (const year of PR_YEARS) {
      if (platform === 'win32') {
        prCandidates.push(join(root, 'Adobe', 'Adobe Premiere Pro ' + year, 'Adobe Premiere Pro.exe'));
        meCandidates.push(join(root, 'Adobe', 'Adobe Media Encoder ' + year, 'Adobe Media Encoder.exe'));
      } else {
        prCandidates.push(join('/Applications', 'Adobe Premiere Pro ' + year, 'Adobe Premiere Pro ' + year + '.app'));
        meCandidates.push(join('/Applications', 'Adobe Media Encoder ' + year, 'Adobe Media Encoder ' + year + '.app'));
      }
    }
  }

  const ae = choose(aeCandidates), premiere = choose(prCandidates), mediaEncoder = choose(meCandidates), cc = choose(ccCandidates);
  const yearFromPath = (value, pattern) => value ? Number(value.match(pattern)?.[1] || 0) : null;
  const aeYear = yearFromPath(ae, /After Effects (20\d{2})/);
  const premiereYear = yearFromPath(premiere, /Premiere Pro (20\d{2})/);
  const mediaEncoderYear = yearFromPath(mediaEncoder, /Media Encoder (20\d{2})/);
  const premiereVersion = premiere ? versionOf(premiere, platform) : null;
  return {
    supported: true,
    creativeCloud: { installed: Boolean(cc), path: cc },
    afterEffects: { installed: Boolean(ae), version: ae ? versionOf(ae, platform) : null, productYear: aeYear, path: ae },
    premierePro: {
      installed: Boolean(premiere),
      version: premiereVersion,
      productYear: premiereYear,
      uxpCompatible: isPremiereUxpCompatible(premiereVersion),
      path: premiere
    },
    mediaEncoder: { installed: Boolean(mediaEncoder), version: mediaEncoder ? versionOf(mediaEncoder, platform) : null, productYear: mediaEncoderYear, path: mediaEncoder },
    userActionsRequired: [
      !cc && 'install Creative Cloud Desktop and sign in',
      !ae && 'install Adobe After Effects from Creative Cloud',
      !premiere && 'install Adobe Premiere Pro from Creative Cloud'
    ].filter(Boolean)
  };
}

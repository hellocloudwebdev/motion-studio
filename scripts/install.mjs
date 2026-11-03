#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const args = new Set(process.argv.slice(2));
const yes = args.has('--yes') || args.has('-y');
const minimal = args.has('--minimal') || args.has('--skip-software');
const platform = process.platform;
const run = (command, commandArgs, label) => {
  console.log(`[Motion Studio] ${label}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
};
const exists = command => spawnSync(command, ['--version'], { stdio: 'ignore', shell: false }).status === 0;

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
console.log(`Motion Studio 0.2.0 installer — ${platform}/${os.arch()}`);
run('npm', ['install', '--no-audit', '--no-fund'], 'Installing workspace dependencies');

if (!minimal && yes && !exists('ffmpeg')) {
  if (platform === 'win32' && exists('winget')) run('winget', ['install', '--id', 'Gyan.FFmpeg', '--exact', '--accept-package-agreements', '--accept-source-agreements'], 'Installing FFmpeg with WinGet');
  else if (platform === 'darwin' && exists('brew')) run('brew', ['install', 'ffmpeg'], 'Installing FFmpeg with Homebrew');
  else if (platform === 'linux' && exists('apt-get')) run('sudo', ['apt-get', 'update'], 'Refreshing apt package index'), run('sudo', ['apt-get', 'install', '-y', 'ffmpeg'], 'Installing FFmpeg');
  else console.warn('FFmpeg was not installed automatically; install it with your OS package manager.');
}
if (yes) {
  try { run('npm', ['install', '--global', 'hyperframes'], 'Installing HyperFrames CLI'); }
  catch { console.warn('HyperFrames CLI installation failed; install it later with npm install -g hyperframes.'); }
  if (exists('hyperframes')) {
    const browser = spawnSync('hyperframes', ['browser', 'ensure'], { stdio: 'inherit', shell: false });
    if (browser.status !== 0) console.warn('Run hyperframes browser ensure after installation to prepare the render browser.');
  }
}
console.log('Dependency bootstrap finished. Run npm test and node scripts/doctor.mjs to verify your setup.');

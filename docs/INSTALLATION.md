# Installation

## Requirements
- Windows 10/11, macOS or mainstream Linux on x64/ARM64.
- Node.js 22 or newer and npm.
- Internet access for package installation.
- FFmpeg for media processing and HyperFrames browser rendering.
- Adobe applications require separate installation and a valid license.

## Install
Windows PowerShell:
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

macOS/Linux:
```bash
chmod +x install.sh
./install.sh
```

Non-interactive open-source setup:
```bash
./install.sh --yes
```

The bootstrapper installs workspace dependencies. On supported systems, the non-interactive path attempts FFmpeg installation using the native package manager and installs HyperFrames CLI/browser support. Review package-manager output and run `node scripts/doctor.mjs`.

## Licensed software
After Effects, Premiere Pro, Media Encoder, Illustrator, Photoshop and Audition must be installed and activated through Adobe Creative Cloud by the user.

## Verify
```bash
npm test
node scripts/doctor.mjs
```

## Options
- `--yes`: non-interactive install of supported free/open-source components.
- `--minimal`: skip OS-level software installation.
- `--skip-software`: skip FFmpeg installation.

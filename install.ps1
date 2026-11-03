$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
function Get-NodeMajor {
  try { $v = (& node --version 2>$null).Trim(); if ($v -match '^v?(\d+)\.') { return [int]$Matches[1] } } catch {}
  return 0
}
if ((Get-NodeMajor) -lt 22) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing Node.js LTS (22 or newer) with Windows Package Manager...'
    winget install --exact --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  } else {
    throw 'Node.js 22+ is required. Install Node.js LTS from https://nodejs.org/en/download/ and rerun .\install.ps1.'
  }
}
if ((Get-NodeMajor) -lt 22) { throw 'Node.js installation was not detected in this terminal. Close and reopen PowerShell, then rerun .\install.ps1.' }
$NpmBin = Join-Path $env:APPDATA 'npm'
if ($env:Path -notlike "*$NpmBin*") { $env:Path = "$NpmBin;$env:Path" }
$UserPath = [Environment]::GetEnvironmentVariable('Path','User')
if ([string]::IsNullOrWhiteSpace($UserPath)) { $UserPath = '' }
$UserEntries = @($UserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if (-not ($UserEntries | Where-Object { $_ -ieq $NpmBin })) {
  $UserEntries += $NpmBin
  [Environment]::SetEnvironmentVariable('Path', ($UserEntries -join ';'), 'User')
}
Set-Location $Root
& node scripts/install.mjs @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

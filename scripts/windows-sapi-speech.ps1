param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw 'Speech text input is missing.' }
$text = [System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw 'Speech text input is empty.' }
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synthesizer.SetOutputToWaveFile($OutputPath)
  $synthesizer.Speak($text)
}
finally {
  $synthesizer.Dispose()
}

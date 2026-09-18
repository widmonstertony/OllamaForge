[CmdletBinding()]
param(
    [ValidateSet('Fast', 'Quality')]
    [string]$Preset = 'Fast',
    [switch]$PrepareOnly
)

& (Join-Path $PSScriptRoot 'Switch-Codex-Mode.ps1') -Mode Local -LocalPreset $Preset -NoRestart:$PrepareOnly
exit $LASTEXITCODE

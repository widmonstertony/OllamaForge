[CmdletBinding()]
param([switch]$PrepareOnly)

& (Join-Path $PSScriptRoot 'Switch-Codex-Mode.ps1') -Mode Cloud -NoRestart:$PrepareOnly
exit $LASTEXITCODE

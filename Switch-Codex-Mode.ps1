[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Local','Cloud')][string]$Mode,[ValidateSet('Fast','Quality')][string]$LocalPreset='Fast',[switch]$NoRestart)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
if ($Mode -eq 'Local') {
    & $node (Join-Path $PSScriptRoot 'connect.mjs') --no-shortcut
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Write-Output 'Global model switching is retired. Local Codex: npm run local:codex. Native Codex remains unchanged.'
    if (-not $NoRestart) { & (Join-Path $PSScriptRoot 'Launch-Codex-Connected.ps1') -SkipConnect }
} else {
    & $node (Join-Path $PSScriptRoot 'native-model-isolation.mjs') repair
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if (-not $NoRestart) { & (Join-Path $PSScriptRoot 'Launch-Codex-Connected.ps1') -SkipConnect }
}

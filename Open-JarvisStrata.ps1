$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
& (Resolve-OllamaForgeNode) (Join-Path $PSScriptRoot 'strata-assistants.mjs') launch jarvis
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Resolve-OllamaForgeNode) (Join-Path $PSScriptRoot 'strata-assistants.mjs') open-jarvis

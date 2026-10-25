$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
$stateDir = Join-Path $env:LOCALAPPDATA 'OllamaForge'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
& $node (Join-Path $PSScriptRoot 'strata-codex-bridge.mjs') `
    1>> (Join-Path $stateDir 'strata-bridge.stdout.log') `
    2>> (Join-Path $stateDir 'strata-bridge.stderr.log')
exit $LASTEXITCODE

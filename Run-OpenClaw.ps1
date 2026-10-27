$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
& $node (Join-Path $PSScriptRoot 'strata-assistants.mjs') serve-openclaw
exit $LASTEXITCODE

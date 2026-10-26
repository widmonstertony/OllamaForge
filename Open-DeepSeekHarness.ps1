$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
Set-Location -LiteralPath $PSScriptRoot
& $node (Join-Path $PSScriptRoot 'deepseek-harness.mjs') launch
exit $LASTEXITCODE

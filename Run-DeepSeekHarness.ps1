$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
Set-Location -LiteralPath $PSScriptRoot
$runtime = Join-Path $PSScriptRoot '.runtime\deepseek-harness'
& $node (Join-Path $PSScriptRoot 'deepseek-harness.mjs') serve `
    1>> (Join-Path $runtime 'web.stdout.log') `
    2>> (Join-Path $runtime 'web.stderr.log')
exit $LASTEXITCODE

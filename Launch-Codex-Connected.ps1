[CmdletBinding()]
param([switch]$PrepareOnly, [switch]$SkipConnect)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
if (-not $SkipConnect) {
    & (Resolve-OllamaForgeNode) (Join-Path $PSScriptRoot 'connect.mjs') --no-shortcut
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if ($PrepareOnly) { Write-Output 'Isolated local profile prepared. Native Codex was not changed or restarted.'; exit 0 }
$entry = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | Select-Object -First 1
$appId = if ($entry) { $entry.AppID } else { 'OpenAI.Codex_2p2nqsd0c76g0!App' }
Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $appId) -WindowStyle Normal
Write-Output 'Opened native Codex. Existing chats, provider and native model catalog remain unchanged.'

[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$strata = Initialize-OllamaForgeStrata
if (-not $strata) { throw 'Strata is not installed. Run npm run download:strata explicitly first.' }
$planText = (& $strata launch --preset 'Codex IQ3_S 128K' --plan --no-tui --output json | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the saved Strata preset before restart.' }
Assert-OllamaForgeStrataPlanReady ($planText | ConvertFrom-Json)
$health = $null; $metrics = $null
try { $health = Invoke-RestMethod http://127.0.0.1:8080/health -TimeoutSec 3 } catch { }
if ($health) { try { $metrics = Invoke-RestMethod http://127.0.0.1:8080/metrics -TimeoutSec 3 } catch { } }
Assert-OllamaForgeStrataRestart -Health $health -Metrics $metrics -Force:$Force

$taskName = 'OllamaForgeStrataStartup'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $PSScriptRoot 'Start-StrataBackground.ps1'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
if ($task -and -not ($task.Actions | Where-Object { $_.Execute -eq $powershell -and $_.Arguments -eq $arguments })) {
    throw 'The startup task belongs to another checkout. Refusing to control it.'
}
$resume = $task -and $task.State -eq 'Running' -and $task.Settings.Enabled
try {
    if ($resume) { Stop-ScheduledTask -TaskName $taskName }
    # Keep the cloud gateway and bridge alive while only the local model reloads.
    & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -InfrastructureOnly
    Write-Host 'Restarting the saved IQ3_S 128K preset. Local requests wait for model loading.'
    & $strata launch --stop --preset 'Codex IQ3_S 128K' --yes --no-tui
    if ($LASTEXITCODE -ne 0) { throw 'Official Strata stop failed. No process was force-killed.' }
    & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -RuntimeOnly
    Write-Host 'Restart complete: IQ3_S 128K and its Codex connection are ready.'
} finally {
    if ($resume) { Start-ScheduledTask -TaskName $taskName }
}

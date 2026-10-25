[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$taskName = 'OllamaForgeStrataStartup'
$runner = Join-Path $PSScriptRoot 'Start-StrataBackground.ps1'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and -not (Test-OllamaForgeBackgroundTask $existing $runner)) {
    throw "Scheduled task $taskName belongs to another checkout. Refusing to overwrite it."
}
if ($Disable) {
    if ($existing) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $taskName | Out-Null
    }
    Write-Host 'Automatic Strata startup disabled. Already running model and bridge remain available.'
    exit 0
}
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$background = Get-OllamaForgeBackgroundAction $runner
$action = New-ScheduledTaskAction -Execute $background.Execute -Argument $background.Arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($existing) {
    if ($existing.State -eq 'Running' -and -not ($existing.Actions | Where-Object { $_.Execute -eq $background.Execute -and $_.Arguments -eq $background.Arguments })) {
        Stop-ScheduledTask -TaskName $taskName
    }
    Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
} else {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'OllamaForge: start cloud gateway and IQ3_S on user login; recover stopped services every 30 seconds.' | Out-Null
}
Enable-ScheduledTask -TaskName $taskName | Out-Null
# Migrate a healthy legacy bridge as well: its HTTP health alone cannot tell
# whether the task still owns a visible PowerShell/Terminal console.
& (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -InfrastructureOnly
Start-ScheduledTask -TaskName $taskName
Write-Host 'Enabled: automatic startup at Windows user login, with background recovery. No model downloads or Codex restart.'

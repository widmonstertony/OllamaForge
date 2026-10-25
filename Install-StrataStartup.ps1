[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$taskName = 'OllamaForgeStrataStartup'
$runner = Join-Path $PSScriptRoot 'Start-StrataBackground.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions | Where-Object { $_.Execute -eq $powershell -and $_.Arguments -eq $arguments })) {
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
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($existing) {
    Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
} else {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'OllamaForge: start cloud gateway and IQ3_S on user login; recover stopped services every 30 seconds.' | Out-Null
}
Enable-ScheduledTask -TaskName $taskName | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'Enabled: automatic startup at Windows user login, with background recovery. No model downloads or Codex restart.'

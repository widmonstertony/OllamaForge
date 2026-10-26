[CmdletBinding()]
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$runner = Join-Path $PSScriptRoot 'Run-DeepSeekHarness.ps1'
$action = Get-OllamaForgeBackgroundAction $runner
$name = 'OllamaForgeDeepSeekHarness'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task -and -not (Test-OllamaForgeBackgroundTask $task $runner $action)) { throw 'This Harness task belongs to another checkout. Refusing to replace it.' }
if ($Stop) {
    if ($task) { Stop-ScheduledTask -TaskName $name }
    return
}
$connectionFile = Join-Path $PSScriptRoot '.runtime\deepseek-harness\connection.json'
$connection = Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json
$listener = Get-NetTCPConnection -LocalPort $connection.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    $bin = Join-Path $PSScriptRoot '.runtime\deepseek-harness\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notlike "*$bin*") { throw 'Harness port belongs to another application. Select a different --port.' }
}
if (-not $task) {
    $scheduled = New-ScheduledTaskAction -Execute $action.Execute -Argument $action.Arguments -WorkingDirectory $PSScriptRoot
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $scheduled -Principal $principal -Settings $settings -Description 'OllamaForge-owned DeepSeek Harness Web UI; loopback only, no console' | Out-Null
}
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $name }
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) {
    $launcher = Get-OllamaForgeBackgroundAction (Join-Path $PSScriptRoot 'Open-DeepSeekHarness.ps1')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop 'OllamaForge - DeepSeek Harness.lnk'))
    $shortcut.TargetPath = $launcher.Execute
    $shortcut.Arguments = $launcher.Arguments
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = 'Open the local DeepSeek Harness connected to OllamaForge'
    $shortcut.Save()
}

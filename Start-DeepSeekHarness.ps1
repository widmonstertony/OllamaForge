[CmdletBinding()]
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$runner = Join-Path $PSScriptRoot 'Run-DeepSeekHarness.ps1'
$action = Get-OllamaForgeBackgroundAction $runner
$name = 'OllamaForgeDeepSeekHarness'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task -and -not (Test-OllamaForgeBackgroundTask $task $runner $action)) { throw 'This Harness task belongs to another checkout. Refusing to replace it.' }
$connectionFile = Join-Path $PSScriptRoot '.runtime\deepseek-harness\connection.json'
$connection = Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json
$bin = Join-Path $PSScriptRoot '.runtime\deepseek-harness\node_modules\@deepseek-ai\dsh\lib\bin.js'
function Get-OwnedHarnessListener {
    $listener = Get-NetTCPConnection -LocalPort $connection.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notlike "*$bin* web *") { throw 'Harness port belongs to another application. Select a different --port.' }
    return $owner
}
function Stop-OwnedHarnessListener($Owner) {
    if (-not $Owner) { return }
    # The common GUI host deliberately lets detached services outlive its job.
    # Reclaim only this checkout's identified server and its owned picker worker.
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Owner.ProcessId)" | ForEach-Object {
        if ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$PSScriptRoot\.runtime\deepseek-harness\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs*") { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }
    Stop-Process -Id $Owner.ProcessId -ErrorAction SilentlyContinue
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($Owner.ParentProcessId)" -ErrorAction SilentlyContinue
    $wrapper = Join-Path $PSScriptRoot 'deepseek-harness.mjs'
    if ($parent.Name -eq 'node.exe' -and $parent.CommandLine -like "*$wrapper* serve*") { Stop-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue }
}
$owner = Get-OwnedHarnessListener
if ($Stop) {
    if ($task) { Stop-ScheduledTask -TaskName $name }
    Stop-OwnedHarnessListener $owner
    return
}
if ($owner -and ($task.State -ne 'Running' -or $owner.CommandLine -notlike '*web-guard.patch.yml*')) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name; Start-Sleep -Milliseconds 500 }
    Stop-OwnedHarnessListener $owner
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
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

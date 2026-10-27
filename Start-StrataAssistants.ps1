[CmdletBinding()]
param([ValidateSet('both','openclaw','jarvis')][string]$WaitFor = 'both')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$saved = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\strata-assistants.json') -Raw | ConvertFrom-Json
$services = @(
    @{Name='OllamaForgeOpenClaw';Runner='Run-OpenClaw.ps1';Open='Open-OpenClaw.ps1';Port=$saved.openclawPort;Needle=(Join-Path $PSScriptRoot '.runtime\openclaw\node_modules\openclaw');Shortcut='OllamaForge - OpenClaw Strata'},
    @{Name='OllamaForgeJarvisStrata';Runner='Run-JarvisStrata.ps1';Open='Open-JarvisStrata.ps1';Port=$saved.jarvisPort;Needle=(Join-Path $saved.jarvis 'scripts\browser_bridge.py');Shortcut='OllamaForge - JARVIS Strata'}
)
foreach ($service in $services) {
    $runner = Join-Path $PSScriptRoot $service.Runner
    $action = Get-OllamaForgeBackgroundAction $runner
    $task = Get-ScheduledTask -TaskName $service.Name -ErrorAction SilentlyContinue
    if ($task -and -not (Test-OllamaForgeBackgroundTask $task $runner $action)) { throw 'Assistant task belongs to another checkout.' }
    $listener = Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        if ($owner.CommandLine -notlike "*$($service.Needle)*") { throw ('Port ' + $service.Port + ' belongs to another application. No service was replaced.') }
    }
    if (-not $task) {
        $scheduled = New-ScheduledTaskAction -Execute $action.Execute -Argument $action.Arguments -WorkingDirectory $PSScriptRoot
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $service.Name -Action $scheduled -Principal $principal -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId) -Description 'Local Strata assistant, loopback only, no terminal' | Out-Null
    }
    if (-not $listener -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName $service.Name }
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) {
        $launcher = Get-OllamaForgeBackgroundAction (Join-Path $PSScriptRoot $service.Open)
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $desktop ($service.Shortcut + '.lnk')))
        $shortcut.TargetPath=$launcher.Execute; $shortcut.Arguments=$launcher.Arguments; $shortcut.WorkingDirectory=$PSScriptRoot; $shortcut.Save()
    }
}
Write-Output 'Background tasks and desktop shortcuts are ready; waiting for the requested local service.'
$deadline = (Get-Date).AddMinutes(6)
$waitPorts = @()
if ($WaitFor -ne 'jarvis') { $waitPorts += $saved.openclawPort }
if ($WaitFor -ne 'openclaw') { $waitPorts += $saved.jarvisPort }
foreach ($port in $waitPorts) {
    do {
        try { $ready = (Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    } while (-not $ready -and (Get-Date) -lt $deadline)
    if (-not $ready) { throw ('Assistant on port ' + $port + ' did not become ready. Inspect .runtime logs.') }
}
Write-Output 'The requested Strata assistant service is ready. No terminal window is required.'

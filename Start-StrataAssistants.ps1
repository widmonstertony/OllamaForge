[CmdletBinding()]
param([ValidateSet('both','openclaw','jarvis')][string]$WaitFor = 'both', [switch]$RegisterOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$saved = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\strata-assistants.json') -Raw -Encoding UTF8 | ConvertFrom-Json
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
        if (-not $owner.CommandLine -or $owner.CommandLine.IndexOf($service.Needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw ('Port ' + $service.Port + ' belongs to another application. No service was replaced.') }
    }
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.Priority = 4 # Normal: the default 7 makes every worker BelowNormal.
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $userId))
    if ($service.Name -eq 'OllamaForgeOpenClaw') {
        # Non-zero GUI child exits do not reliably activate RestartOnFailure on
        # every Windows installation. This also recovers a dead supervisor.
        $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    }
    if (-not $task) {
        $scheduled = New-ScheduledTaskAction -Execute $action.Execute -Argument $action.Arguments -WorkingDirectory $PSScriptRoot
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $service.Name -Action $scheduled -Principal $principal -Settings $settings -Trigger $triggers -Description 'Local Strata assistant, loopback only, no terminal' | Out-Null
    } else { Set-ScheduledTask -TaskName $service.Name -Settings $settings -Trigger $triggers | Out-Null }
    if (-not $RegisterOnly -and -not $listener -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName $service.Name }
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) {
        $launcher = Get-OllamaForgeBackgroundAction (Join-Path $PSScriptRoot $service.Open)
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $desktop ($service.Shortcut + '.lnk')))
        $shortcut.TargetPath=$launcher.Execute; $shortcut.Arguments=$launcher.Arguments; $shortcut.WorkingDirectory=$PSScriptRoot; $shortcut.Save()
    }
}
if ($RegisterOnly) { Write-Output 'Assistant login/recovery tasks registered; no service was manually started.'; return }
Write-Output 'Background tasks and desktop shortcuts are ready; waiting for the requested local service.'
$deadline = (Get-Date).AddMinutes(15)
$waitPorts = @()
if ($WaitFor -ne 'jarvis') { $waitPorts += $saved.openclawPort }
if ($WaitFor -ne 'openclaw') { $waitPorts += $saved.jarvisPort }
foreach ($port in $waitPorts) {
    do {
        try {
            $endpoint = if ($port -eq $saved.openclawPort) { '/readyz' } else { '/' }
            $ready = (Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + $endpoint) -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
            if ($ready -and $port -eq $saved.openclawPort) {
                $receipt = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\openclaw-ready.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $ownerPid = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
                $ready = $receipt.pid -eq $ownerPid -and $receipt.model -eq $saved.model
                $strata = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 2
                $ready = $ready -and $strata.loaded -and $strata.model -eq $saved.model
            }
        } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    } while (-not $ready -and (Get-Date) -lt $deadline)
    if (-not $ready) { throw ('Assistant on port ' + $port + ' did not become ready. Inspect .runtime logs.') }
}
Write-Output 'The requested Strata assistant service is ready. No terminal window is required.'

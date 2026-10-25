[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$RuntimeOnly,
    [switch]$InfrastructureOnly,
    [switch]$EnableStartup,
    [switch]$CheckRuntimePaths,
    [switch]$CheckHardware,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'Strata-data' }
$stateDir = Join-Path $env:LOCALAPPDATA 'OllamaForge'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
function Test-Strata {
    try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 3; return ($h.service -eq 'strata' -and $h.loaded -and $h.max_context -eq 131072 -and $h.model -eq 'qwen3.8-flash-next-iq3_s') }
    catch { return $false }
}
$node = Resolve-OllamaForgeNode
$hardware = if ($Install -or $CheckHardware) { Read-StrataHardwareProfile } else { $null }
if ($CheckHardware) { $hardware | ConvertTo-Json; return }
$ollama = Resolve-OllamaForgeOllama
Start-OllamaForgeGateway -Ollama $ollama -StateDirectory $stateDir
$strata = Initialize-OllamaForgeStrata -SkipRuntimeRepair:$InfrastructureOnly
if (-not $strata -and $Install) {
    $installer = Join-Path $stateDir 'install-strata-terminal.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/Niko1221/Strata/releases/latest/download/install.ps1' -OutFile $installer
    # Upstream verifies the Terminal archive SHA-256 and the signed release feed.
    & $installer
    $strata = Initialize-OllamaForgeStrata
}
if ($Install) {
    if (-not $strata) { throw 'Strata Terminal was not installed.' }
    Write-Host ("IQ3_S profile: {0:N1} GiB RAM; {1}; expert RAM budget {2} GiB." -f $hardware.RamGiB, $hardware.GpuName, $hardware.ResidentBudgetGiB)
    & $strata launch --family qwen --model iq3_s --context 128k --kv q4_0 --mtp off --drafting off `
        --gpus $hardware.GpuIndex --vision cpu --parallel 1 --set "vram-reserve-mib=$($hardware.VramReserveMiB)" --set "resident-budget-gib=$($hardware.ResidentBudgetGiB)" --access local --port 8080 --data-dir $DataDirectory `
        --save-preset 'Codex IQ3_S 128K' --yes --no-tui
    if ($LASTEXITCODE -ne 0) { throw "Strata installation failed: $LASTEXITCODE" }
} elseif ($RuntimeOnly -and -not $InfrastructureOnly -and -not (Test-Strata)) {
    if (-not $strata) { throw 'Strata is missing. Run npm run download:strata once.' }
    $planText = (& $strata launch --preset 'Codex IQ3_S 128K' --plan --no-tui --output json | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the saved Strata preset before startup.' }
    $plan = $planText | ConvertFrom-Json
    Assert-OllamaForgeStrataPlanReady $plan
    & $strata launch --preset 'Codex IQ3_S 128K' --yes --no-tui
    if ($LASTEXITCODE -ne 0) { throw "Strata startup failed: $LASTEXITCODE" }
}
if (-not $InfrastructureOnly -and -not (Test-Strata)) { throw 'Start the Strata Codex IQ3_S 128K preset first, or run npm run download:strata to install it.' }
if ($CheckRuntimePaths) {
    if (-not $strata) { throw 'The desktop context cannot find Strata Terminal.' }
    & $strata launch --preset 'Codex IQ3_S 128K' --plan --no-tui --output json
    if ($LASTEXITCODE -ne 0) { throw 'The desktop context cannot read the IQ3_S preset.' }
}

$bridgeReady = $false
try { $h = Invoke-RestMethod 'http://127.0.0.1:11436/health' -TimeoutSec 2; $bridgeReady = ($h.service -eq 'ollamaforge-strata-bridge' -and $h.model -eq 'qwen3.8-flash-next-iq3_s') } catch {}
$bridge = Join-Path $PSScriptRoot 'strata-codex-bridge.mjs'
$taskName = 'OllamaForgeStrataBridge'
$runner = Join-Path $PSScriptRoot 'Run-StrataBridge.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$legacyTask = $task -and ($task.Actions | Where-Object { $_.Arguments -eq ('"' + $bridge + '"') -and $_.Execute -eq $node })
if ($task -and -not $legacyTask -and -not ($task.Actions | Where-Object { $_.Arguments -eq $taskArguments -and $_.Execute -eq $powershell })) {
    throw "Scheduled task $taskName belongs to another checkout/runtime. Refusing to overwrite it."
}
if (-not $task -or $legacyTask) {
    # A scheduler-owned process survives closing/reopening the Codex application.
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArguments -WorkingDirectory $PSScriptRoot
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    if ($legacyTask) {
        Stop-ScheduledTask -TaskName $taskName
        $task = Set-ScheduledTask -TaskName $taskName -Action $action -Settings $settings
        $bridgeReady = $false
    } else {
        $task = Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings `
            -Description 'User-owned OllamaForge Strata/cloud loopback bridge; started on demand'
    }
    if ($bridgeReady) {
        $listener = Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction Stop | Select-Object -First 1
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        if ($owner.Name -notmatch '^node(\.exe)?$' -or $owner.CommandLine -notlike "*$bridge*") {
            throw 'Port 11436 is not owned by this bridge. Refusing to replace it.'
        }
        Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
        $bridgeReady = $false
    }
}
if (-not $bridgeReady) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName; Start-Sleep -Milliseconds 500 }
    # Stopping a scheduler-owned PowerShell can leave its native node child alive.
    # Replace only a listener whose executable and command line identify this repo.
    $stale = Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($stale) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($stale.OwningProcess)"
        if ($owner.Name -notmatch '^node(\.exe)?$' -or $owner.CommandLine -notlike "*$bridge*") {
            throw 'Port 11436 is occupied by another application. Refusing to stop it.'
        }
        Stop-Process -Id $stale.OwningProcess -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }
    if (-not $task.Settings.Enabled) { Enable-ScheduledTask -TaskName $taskName | Out-Null }
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        try { $h = Invoke-RestMethod 'http://127.0.0.1:11436/health' -TimeoutSec 2 } catch { $h = $null }
    } while (($h.service -ne 'ollamaforge-strata-bridge' -or $h.model -ne 'qwen3.8-flash-next-iq3_s') -and (Get-Date) -lt $deadline)
    if ($h.service -ne 'ollamaforge-strata-bridge' -or $h.model -ne 'qwen3.8-flash-next-iq3_s') { throw 'OllamaForge Strata bridge failed to start. Check the bridge stderr log.' }
}
if (-not $RuntimeOnly -and -not $InfrastructureOnly) {
    & $node (Join-Path $PSScriptRoot 'strata-setup.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Strata Codex connection failed.' }
}
if ($EnableStartup) {
    & (Join-Path $PSScriptRoot 'Install-StrataStartup.ps1')
}
if ($InfrastructureOnly) { Write-Host 'Ready: Ollama and the loopback bridge. Local model loading is independent.' }
else { Write-Host 'Ready: Strata - Qwen3.8 Flash 128K (IQ3_S). The cloud default is preserved.' }

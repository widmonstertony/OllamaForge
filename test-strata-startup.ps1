$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Repair-StrataRuntimeAlias.ps1')
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$originalRuntime = $env:STRATA_RUNTIME_DIR
$originalFixture = $env:OLLAMAFORGE_RESTART_FIXTURE
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ollamaforge-runtime-alias-' + [guid]::NewGuid().ToString('N'))
$physical = Join-Path $testRoot 'Local\Strata\runtime'
New-Item -ItemType Directory -Path $physical -Force | Out-Null
try {
    $readyPlan = [pscustomobject]@{ok=$true;plan=[pscustomobject]@{download=[pscustomobject]@{gb=0;parts=@();engine_missing=$false;engine_usable=$true}}}
    Assert-OllamaForgeStrataPlanReady $readyPlan
    $readyPlan.plan.download.gb = 1
    $rejected=$false
    try { Assert-OllamaForgeStrataPlanReady $readyPlan } catch { $rejected=$true }
    if (-not $rejected) { throw 'Restart must not download missing model files.' }
    $health = [pscustomobject]@{service='strata';model='qwen3.8-flash-next-iq3_s';loaded=$true;max_context=131072}
    $metrics = [pscustomobject]@{live=[pscustomobject]@{state='idle';queued=0}}
    Assert-OllamaForgeStrataRestart $health $metrics
    $health.loaded=$false
    $metrics.live.state='unloaded'
    Assert-OllamaForgeStrataRestart $health $metrics
    $health.loaded=$true
    $metrics.live.state='generating'
    $rejected=$false
    try { Assert-OllamaForgeStrataRestart $health $metrics } catch { $rejected=$true }
    if (-not $rejected) { throw 'Restart must protect an active local request.' }
    Assert-OllamaForgeStrataRestart $health $metrics -Force
    $health.model='another-model'
    $rejected=$false
    try { Assert-OllamaForgeStrataRestart $health $metrics -Force } catch { $rejected=$true }
    if (-not $rejected) { throw 'Even forced restart must not replace another model.' }
    Write-Host 'PASS: restart rejects missing files, protects active requests, and refuses another runtime.'
    $fixture = Join-Path $testRoot 'Restart fixture with spaces'
    New-Item -ItemType Directory -Path $fixture | Out-Null
    $env:OLLAMAFORGE_RESTART_FIXTURE = $fixture
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Restart-Strata.ps1') -Destination (Join-Path $fixture 'Restart-Strata.ps1')
    $common = (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1').Replace("'", "''")
    $stub = ". '$common'`n" + @'
function Initialize-OllamaForgeStrata { Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'fake-strata.ps1' }
function Invoke-RestMethod { param($Uri,$TimeoutSec)
    if ($Uri -like '*/metrics') { return [pscustomobject]@{live=[pscustomobject]@{state='idle';queued=0}} }
    return [pscustomobject]@{service='strata';model='qwen3.8-flash-next-iq3_s';loaded=$true;max_context=131072}
}
function Get-ScheduledTask { param($TaskName,$ErrorAction)
    $case = Get-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'case.json') -Raw | ConvertFrom-Json
    $runner = Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'Start-StrataBackground.ps1'
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
    if ($case.Foreign) { $arguments = 'another-checkout' }
    return [pscustomobject]@{State=$(if($case.Enabled){'Running'}else{'Disabled'});Settings=[pscustomobject]@{Enabled=$case.Enabled};Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');Arguments=$arguments})}
}
function Stop-ScheduledTask { param($TaskName) Add-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'events.txt') 'pause' }
function Start-ScheduledTask { param($TaskName) Add-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'events.txt') 'resume' }
'@
    Set-Content -LiteralPath (Join-Path $fixture 'Strata-WindowsRuntime.ps1') -Value $stub -Encoding UTF8
    @'
$global:LASTEXITCODE = 0
if ($args -contains '--plan') {
    '{"ok":true,"plan":{"download":{"gb":0,"parts":[],"engine_missing":false,"engine_usable":true}}}'
} elseif ($args -contains '--stop') { Add-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'events.txt') 'stop-owned-profile' }
'@ | Set-Content -LiteralPath (Join-Path $fixture 'fake-strata.ps1') -Encoding UTF8
    @'
param([switch]$InfrastructureOnly,[switch]$RuntimeOnly)
$case = Get-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'case.json') -Raw | ConvertFrom-Json
if ($InfrastructureOnly) { Add-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'events.txt') 'infra' }
if ($RuntimeOnly) {
    Add-Content (Join-Path $env:OLLAMAFORGE_RESTART_FIXTURE 'events.txt') 'load'
    if ($case.FailLoad) { throw 'Simulated model load failure' }
}
'@ | Set-Content -LiteralPath (Join-Path $fixture 'Setup-Strata.ps1') -Encoding UTF8
    foreach ($case in @(
        @{Enabled=$true;FailLoad=$false;Foreign=$false;Fails=$false;Events='pause,infra,stop-owned-profile,load,resume'},
        @{Enabled=$true;FailLoad=$true;Foreign=$false;Fails=$true;Events='pause,infra,stop-owned-profile,load,resume'},
        @{Enabled=$false;FailLoad=$false;Foreign=$false;Fails=$false;Events='infra,stop-owned-profile,load'},
        @{Enabled=$true;FailLoad=$false;Foreign=$true;Fails=$true;Events=''}
    )) {
        $case | ConvertTo-Json | Set-Content (Join-Path $fixture 'case.json') -Encoding UTF8
        Set-Content (Join-Path $fixture 'events.txt') -Value '' -Encoding UTF8
        $failed = $false
        try { & (Join-Path $fixture 'Restart-Strata.ps1') } catch { $failed = $true }
        if ($failed -ne $case.Fails) { throw 'Restart failure propagation mismatch.' }
        $events = (@(Get-Content (Join-Path $fixture 'events.txt') | Where-Object { $_ }) -join ',')
        if ($events -ne $case.Events) { throw "Restart lifecycle mismatch: $events" }
    }
    Write-Host 'PASS: restart resumes its supervisor after success/failure, keeps disabled startup off and refuses another checkout.'
    foreach ($version in @('24.22.1','24.99.0','26.12.1')) {
        if (-not (Test-OllamaForgeNodeVersion ([version]$version))) { throw "Supported Node version rejected: $version" }
    }
    foreach ($version in @('22.0.0','24.22.0','25.0.0','26.12.0','27.0.0')) {
        if (Test-OllamaForgeNodeVersion ([version]$version)) { throw "Unsupported Node version accepted: $version" }
    }
    $gpuSet = @(
        [pscustomobject]@{Index=0;Name='GPU small';MemoryMiB=8192},
        [pscustomobject]@{Index=1;Name='GPU larger';MemoryMiB=24576}
    )
    $profile = Get-StrataHardwareProfile -RamGiB 63.6 -Gpus $gpuSet
    if ($profile.GpuIndex -ne 1 -or $profile.ResidentBudgetGiB -ne 40) { throw 'Wrong GPU or RAM budget selected.' }
    $largeProfile = Get-StrataHardwareProfile -RamGiB 127.5 -Gpus $gpuSet
    if ($largeProfile.ResidentBudgetGiB -ne 48) { throw 'Expert RAM budget must adapt on larger PCs.' }
    foreach ($case in @(@{RamGiB=32;Gpus=$gpuSet}, @{RamGiB=64;Gpus=@($gpuSet[0])}, @{RamGiB=64;Gpus=$gpuSet;Architecture='ARM64'})) {
        $rejected = $false
        try { $null = Get-StrataHardwareProfile @case } catch { $rejected = $true }
        if (-not $rejected) { throw 'Incompatible hardware must fail before model download.' }
    }
    $terminal = Join-Path $testRoot ('Other User With Spaces '+[char]0x7528+[char]0x6237+'\Strata\terminal')
    foreach ($version in @('0.1.9','0.1.49.2','current','0.2.0-beta')) {
        $bin = Join-Path (Join-Path $terminal $version) 'bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $bin 'strata.ps1') -Value '# fixture' -Encoding UTF8
    }
    if ((Get-StrataTerminalPath -Roots @((Join-Path $testRoot 'missing'), $terminal)) -ne (Join-Path $terminal '0.1.49.2\bin\strata.ps1')) { throw 'Version discovery must work with spaces and ignore non-version folders.' }
    Write-Host 'PASS: Node version policy, 64/128GB RAM, multi-GPU selection, incompatible hardware and custom installation paths.'
    $env:STRATA_RUNTIME_DIR = $physical
    $token = 'a' * 64
    $name = 'launch-codex-iq3_s-128k-' + ('b' * 32) + '.ready.json'
    $alias = Join-Path ([Environment]::GetFolderPath('UserProfile')) ('AppData\Local\Strata\runtime\' + $name)
    $marker = Join-Path $physical ('launch-codex-iq3_s-128k-' + $token + '.child.json')
    @{profile='launch-codex-iq3_s-128k';token=$token} | ConvertTo-Json | Set-Content (Join-Path $physical 'launch-codex-iq3_s-128k.json') -Encoding UTF8
    @{host_token=$token;phase='owned';pid=12345;ready=$alias} | ConvertTo-Json | Set-Content $marker -Encoding UTF8
    @{pid=12345;model_id='qwen3.8-flash-next-iq3_s'} | ConvertTo-Json | Set-Content (Join-Path $physical $name) -Encoding UTF8
    Repair-StrataRuntimeAlias $testRoot
    $result = Get-Content -Raw $marker | ConvertFrom-Json
    if ($result.ready -ne (Join-Path $physical $name)) { throw 'Alias was not normalized.' }
    $backup = Get-Content -Raw ($marker + '.ollamaforge.bak') | ConvertFrom-Json
    if ($backup.ready -ne $alias) { throw 'Original owner marker was not preserved.' }
    $before = Get-Content -Raw $marker
    Repair-StrataRuntimeAlias $testRoot
    if ((Get-Content -Raw $marker) -ne $before) { throw 'Repeated repair must be a no-op.' }
    $result.ready = $alias
    $result.pid = 99999
    $result | ConvertTo-Json | Set-Content $marker -Encoding UTF8
    Repair-StrataRuntimeAlias $testRoot
    if ((Get-Content -Raw $marker | ConvertFrom-Json).ready -ne $alias) { throw 'Mismatched ready file must not be adopted.' }
    $unicodeUser = Join-Path $testRoot ('User '+[char]0x7528+[char]0x6237)
    $unicodeAlias = Join-Path $unicodeUser ('AppData\Local\Strata\runtime\' + $name)
    $result.ready = $unicodeAlias
    $result.pid = 12345
    [IO.File]::WriteAllText($marker, ($result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    Repair-StrataRuntimeAlias -PackageCache $testRoot -UserProfile $unicodeUser
    if ((Get-Content -Raw -Encoding UTF8 $marker | ConvertFrom-Json).ready -ne (Join-Path $physical $name)) { throw 'UTF-8 owner records with Unicode user names must be recovered.' }
    Write-Host 'PASS: UTF-8 JSON without BOM and Unicode user profiles under Windows PowerShell 5.1.'
    Write-Host 'PASS: Store/desktop runtime alias recovery, backup, idempotence and mismatched-child refusal.'
} finally {
    $env:STRATA_RUNTIME_DIR = $originalRuntime
    $env:OLLAMAFORGE_RESTART_FIXTURE = $originalFixture
    # The generated absolute fixture directory is the sole recursive cleanup target.
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'ollamaforge-runtime-alias-*') { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

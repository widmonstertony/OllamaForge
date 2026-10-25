$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Repair-StrataRuntimeAlias.ps1')
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$originalRuntime = $env:STRATA_RUNTIME_DIR
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ollamaforge-runtime-alias-' + [guid]::NewGuid().ToString('N'))
$physical = Join-Path $testRoot 'Local\Strata\runtime'
New-Item -ItemType Directory -Path $physical -Force | Out-Null
try {
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
    $terminal = Join-Path $testRoot 'Other User With Spaces\Strata\terminal'
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
    Write-Host 'PASS: Store/desktop runtime alias recovery, backup, idempotence and mismatched-child refusal.'
} finally {
    $env:STRATA_RUNTIME_DIR = $originalRuntime
    # The generated absolute fixture directory is the sole recursive cleanup target.
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'ollamaforge-runtime-alias-*') { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

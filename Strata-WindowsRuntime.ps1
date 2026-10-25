function Test-OllamaForgeNodeVersion([version]$Version) {
    return (($Version -ge [version]'24.22.1' -and $Version.Major -eq 24) -or
        ($Version -ge [version]'26.12.1' -and $Version.Major -eq 26))
}

function Resolve-OllamaForgeNode {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate) {
            try {
                $version = & $candidate -p 'process.versions.node'
                if ($LASTEXITCODE -eq 0 -and (Test-OllamaForgeNodeVersion ([version]$version))) { return $candidate }
            } catch { }
        }
    }
    throw 'Install supported Node.js: 24.22.1+ (24.x) or 26.12.1+ (26.x), then retry.'
}

function Resolve-OllamaForgeOllama {
    $command = Get-Command ollama -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ollama.exe'),
        (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'Install Ollama with ollama launch chatgpt support, then retry.'
}

function Start-OllamaForgeGateway([string]$Ollama, [string]$StateDirectory) {
    try { $ready = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 } catch { $ready = $null }
    if (-not $ready.version) {
        Start-Process -FilePath $Ollama -ArgumentList 'serve' -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $StateDirectory 'ollama-serve.stdout.log') `
            -RedirectStandardError (Join-Path $StateDirectory 'ollama-serve.stderr.log') | Out-Null
        $deadline = (Get-Date).AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 500
            try { $ready = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 } catch { $ready = $null }
        } while (-not $ready.version -and (Get-Date) -lt $deadline)
        if (-not $ready.version) { throw 'Ollama did not start. Check the OllamaForge logs.' }
    }
    try { $gateway = Invoke-RestMethod 'http://127.0.0.1:11434/api/codex/_health' -TimeoutSec 3 } catch { $gateway = $null }
    if (-not $gateway.ok) { throw 'This Ollama release has no Codex gateway. Update Ollama to a release supporting ollama launch chatgpt, then retry.' }
}

function Get-StrataTerminalPath([string[]]$Roots) {
    foreach ($root in $Roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $versions = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' } |
            Sort-Object { [version]$_.Name } -Descending)
        foreach ($version in $versions) {
            $candidate = Join-Path $version.FullName 'bin\strata.ps1'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
        $current = Join-Path $root 'current\bin\strata.ps1'
        if (Test-Path -LiteralPath $current) { return $current }
    }
    return $null
}

function Get-StrataHardwareProfile([double]$RamGiB, [object[]]$Gpus, [string]$Architecture = 'AMD64') {
    if ($Architecture -notin @('AMD64','x64')) { throw 'This optional Strata installer requires Windows x64. Use npm run setup for other supported Ollama desktop systems.' }
    if ($RamGiB -lt 60) { throw 'The IQ3_S 125B preset requires a 64GB-class RAM system. Use npm run setup with a smaller installed Ollama model on this PC.' }
    $gpu = $Gpus | Where-Object { $_.MemoryMiB -ge 11264 } | Sort-Object MemoryMiB -Descending | Select-Object -First 1
    if (-not $gpu) { throw 'The IQ3_S 128K preset requires a supported NVIDIA GPU with at least 12GB VRAM. Use npm run setup for other GPUs.' }
    return [pscustomobject]@{
        RamGiB = $RamGiB
        GpuIndex = [int]$gpu.Index
        GpuName = [string]$gpu.Name
        VramMiB = [int]$gpu.MemoryMiB
        ResidentBudgetGiB = [int][math]::Min(48, [math]::Floor($RamGiB - 23))
        VramReserveMiB = 2048
    }
}

function Read-StrataHardwareProfile {
    $ramGiB = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory / 1GB
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) { throw 'NVIDIA driver/nvidia-smi is missing. This optional Strata preset requires NVIDIA; use npm run setup for ordinary Ollama models.' }
    $lines = & $smi.Source --query-gpu=index,name,memory.total --format=csv,noheader,nounits
    if ($LASTEXITCODE -ne 0) { throw 'Cannot query NVIDIA GPUs. Check the NVIDIA driver before installing Strata.' }
    $gpus = @($lines | ConvertFrom-Csv -Header Index,Name,MemoryMiB | ForEach-Object {
        [pscustomobject]@{ Index = [int]$_.Index.Trim(); Name = $_.Name.Trim(); MemoryMiB = [int]$_.MemoryMiB.Trim() }
    })
    Get-StrataHardwareProfile -RamGiB $ramGiB -Gpus $gpus -Architecture $env:PROCESSOR_ARCHITECTURE
}

# Install the baked SC117 checkpoint under the stable API model ID used by clients.
function Install-StrataAbliterated($Terminal, $Node, $Hardware, [string]$DataDirectory, [string]$ModelDirectory) {
    $preset = 'Codex IQ3_S 128K'
    $model = 'qwen3.8-flash-next-iq3_s'
    $endpoint = 'http://127.0.0.1:8080'
    $homeDir = Join-Path $DataDirectory 'models\SC117-Qwen3.8-Flash-Next-GSQ-RCO-abliterated'
    $ModelDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ModelDirectory)
    $first = Join-Path $ModelDirectory 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf'
    $propsUri = "$endpoint/props?model=$model&autoload=false"
    $taskName = 'OllamaForgeStrataStartup'
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and -not (Test-OllamaForgeBackgroundTask $task (Join-Path $PSScriptRoot 'Start-StrataBackground.ps1'))) {
        throw 'The existing Strata startup task belongs to another checkout.'
    }
    $lock = New-Object Threading.Mutex($false, 'Local\OllamaForgeInstallSC117')
    $held = $false
    $resume = $false
    $stopped = $false
    try {
        try { $held = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another SC117 deployment is in progress.' }
        & $Node (Join-Path $PSScriptRoot 'strata-abliterated.mjs') $ModelDirectory
        if ($LASTEXITCODE) { throw 'SC117 shard verification failed.' }

        # Upstream setup looks for packs/iq3_s across installs. Give this revision
        # its own first-choice pack so the stock GGUF offsets cannot be reused.
        $runtime = Join-Path $homeDir 'runtime-90a3350c'
        $pack = Join-Path $runtime 'packs\iq3_s'
        New-Item -ItemType Directory -Path $pack -Force | Out-Null
        $manifest = Join-Path $pack 'conversions.json'
        if (Test-Path -LiteralPath (Join-Path $pack 'native_experts.txt')) {
            $sources = @((Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json).source_shards)
            $weights = @(Get-ChildItem -LiteralPath $ModelDirectory -Filter '*.gguf' -File | Sort-Object Name)
            if ($sources.Count -ne 2) { throw "Unexpected pack in $pack" }
            for ($i = 0; $i -lt 2; $i++) {
                if ($sources[$i].name -ne $weights[$i].Name -or $sources[$i].size -ne $weights[$i].Length) { throw "Pack source mismatch in $pack" }
            }
        }
        $tuning = [ordered]@{'resident-budget-gib'=$Hardware.ResidentBudgetGiB; 'conversation-cache-min-tokens'=1024}
        if ($Hardware.GpuName -match 'RTX 4090 Laptop GPU' -and $Hardware.CpuName -match 'i9-13950HX' -and
            $Hardware.RamGiB -ge 60 -and $Hardware.RamGiB -le 65) {
            $tuning['resident-budget-gib'] = 36
            $tuning['prefill'] = 8192
            $tuning['pcie-frac'] = 0
        }
        $launch = @('launch','--family','qwen','--model','iq3_s','--model-path',$first,'--data-dir',$runtime,
            '--context','128k','--kv','q4_0','--mtp','off','--drafting','off','--vision','cpu','--parallel','1',
            '--access','local','--port','8080','--gpu',[string]$Hardware.GpuIndex,
            '--set',"vram-reserve-mib=$($Hardware.VramReserveMiB)",
            '--set','adapt-async=1','--set','STRATA_PIN_BY_NEED=1','--set','STRATA_IQ3S_MT1=1',
            '--set','conversation-cache-slots=2','--set','conversation-cache-mib=2560',
            '--save-preset',$preset,'--yes','--no-tui')
        foreach ($entry in $tuning.GetEnumerator()) { $launch += @('--set', "$($entry.Key)=$($entry.Value)") }
        $health = $null
        try { $health = Invoke-RestMethod "$endpoint/health" -TimeoutSec 3 } catch { }
        if ($health) {
            $metrics = Invoke-RestMethod "$endpoint/metrics" -TimeoutSec 5
            $props = Invoke-RestMethod $propsUri -TimeoutSec 10
            $savedJson = & $Terminal launch --preset $preset --plan --no-tui --output json
            if ($LASTEXITCODE) { throw 'Port 8080 is occupied and this checkout has no matching saved preset.' }
            $savedPlan = ($savedJson | Out-String) | ConvertFrom-Json
            $s = $savedPlan.plan.settings
            $tuningMatches = $true
            foreach ($entry in $tuning.GetEnumerator()) {
                $flag = '--' + $entry.Key
                $value = 0.0
                if (-not [double]::TryParse([string]$s.extra.$flag, [Globalization.NumberStyles]::Float,
                    [Globalization.CultureInfo]::InvariantCulture, [ref]$value) -or $value -ne $entry.Value) { $tuningMatches = $false }
            }
            # Preserve an existing reserve tuned on this GPU when adopting the
            # already-serving baked weights into an explicit own-files preset.
            if ($props.model_path -eq $first -and ($s.gpus -contains $Hardware.GpuIndex -or
                (-not $s.gpus -and $Hardware.GpuIndex -eq 0)) -and $s.extra.'--vram-reserve-mib' -match '^\d+$') {
                $index = [Array]::IndexOf($launch, "vram-reserve-mib=$($Hardware.VramReserveMiB)")
                $launch[$index] = "vram-reserve-mib=$($s.extra.'--vram-reserve-mib')"
            }
            if ($tuningMatches -and $health.service -eq 'strata' -and $health.model -eq $model -and $props.model_path -eq $first -and
                $metrics.engine.context -eq 131072 -and $metrics.engine.kv -eq 'q4_0' -and $metrics.engine.drafting -eq 'off' -and
                $metrics.engine.cvec -in @($null,0,'off','none') -and $s.model_path -eq $first -and
                $s.context -eq 131072 -and $s.kv -eq 'q4_0' -and $s.mtp -eq 'off' -and $s.drafting -eq 'off' -and
                -not $s.extra.'--control-vector-scaled' -and -not $s.extra.'--control-vector') {
                Assert-OllamaForgeStrataPlanReady $savedPlan
                Write-Host 'Verified SC117 128K is already serving from the saved preset.'
                return
            }
            Assert-OllamaForgeStrataRestart $health $metrics
            $inventory = ((& $Terminal models list --output json) | Out-String) | ConvertFrom-Json
            $oldConfig = @($inventory.models | Where-Object { [IO.Path]::GetFileName($_.source_config) -eq 'strata-iq3_s.json' })[0]
            if (-not $oldConfig) { throw 'Cannot locate the installed IQ3_S configuration for rollback.' }
            $baseFile = Join-Path $inventory.install_dir 'strata-iq3_s.json'
            $baseBytes = [IO.File]::ReadAllBytes($oldConfig.source_config)
            $presetDir = $env:STRATA_LAUNCH_PRESET_DIR
            if (-not $presetDir) {
                $configDir = if ($env:STRATA_PROFILE_DIR) { Split-Path $env:STRATA_PROFILE_DIR } else { Join-Path $env:APPDATA 'Strata' }
                $presetDir = Join-Path $configDir 'launch-presets'
            }
            $presetFile = Join-Path $presetDir 'codex-iq3_s-128k.json'
            $presetBytes = [IO.File]::ReadAllBytes($presetFile)
        }
        $plan = ((& $Terminal @launch --plan --output json) | Out-String) | ConvertFrom-Json
        if ($LASTEXITCODE -or -not $plan.ok -or $plan.plan.settings.model_path -ne $first -or -not $plan.plan.model.own_files) {
            throw 'Installed Strata Terminal cannot plan this local GGUF deployment.'
        }
        if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName; $resume = $true }
        if ($health) {
            Assert-OllamaForgeStrataRestart (Invoke-RestMethod "$endpoint/health") (Invoke-RestMethod "$endpoint/metrics")
            # Stop only the named launch. --restart may also replace other profiles sharing this port.
            & $Terminal launch --stop --preset $preset --yes --no-tui
            if ($LASTEXITCODE) { throw 'Could not stop the existing Strata preset.' }
            $stopped = $true
        }
        & $Terminal @launch
        if ($LASTEXITCODE) { throw 'Strata could not deploy the selected SC117 files.' }
        $props = Invoke-RestMethod $propsUri -TimeoutSec 15
        $engine = (Invoke-RestMethod "$endpoint/metrics" -TimeoutSec 10).engine
        if ($props.model_path -ne $first -or $engine.model -ne $model -or $engine.context -ne 131072 -or
            $engine.kv -ne 'q4_0' -or $engine.drafting -ne 'off' -or $engine.cvec -notin @($null,0,'off','none')) {
            throw 'Strata did not serve the verified baked weights with the requested 128K settings.'
        }
    } catch {
        if ($stopped) {
            & $Terminal launch --stop --preset $preset --yes --no-tui | Out-Host
            [IO.File]::WriteAllBytes($baseFile,$baseBytes)
            [IO.File]::WriteAllBytes($presetFile,$presetBytes)
            & $Terminal launch --preset $preset --yes --no-tui | Out-Host
            if ($LASTEXITCODE) { Write-Warning 'Previous configuration restored; its runtime did not become ready.' }
        }
        throw
    } finally {
        try { if ($resume) { Start-ScheduledTask -TaskName $taskName } }
        finally { if ($held) { $lock.ReleaseMutex() }; $lock.Dispose() }
    }
}

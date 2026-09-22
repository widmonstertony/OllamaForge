[CmdletBinding()]
param(
    [switch]$PrepareOnly,
    [switch]$SkipConnect
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'OllamaForge'
$logPath = Join-Path $stateDir 'shortcut.log'
$endpoint = 'http://127.0.0.1:11434'
$fallbackAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-LauncherLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value ("{0:u} {1}" -f (Get-Date), $Message) -Encoding utf8
}

function Resolve-Executable([string]$Name, [string[]]$Candidates, [string]$SearchRoot, [string]$SearchPattern) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and (Test-Path -LiteralPath $command.Source)) { return $command.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    if ($SearchRoot -and (Test-Path -LiteralPath $SearchRoot)) {
        $match = Get-ChildItem -LiteralPath $SearchRoot -Filter $SearchPattern -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    throw "$Name was not found. Install it, then run the repository setup again."
}

function Resolve-Node {
    Resolve-Executable 'node' @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\node.exe')
    ) (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') 'node.exe'
}

function Resolve-Ollama {
    Resolve-Executable 'ollama' @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ollama.exe'),
        (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
    ) (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') 'ollama.exe'
}

function Test-OllamaReady {
    try {
        $version = Invoke-RestMethod -Uri "$endpoint/api/version" -TimeoutSec 2
        return [bool]$version.version
    } catch {
        return $false
    }
}

function Ensure-OllamaReady {
    if (Test-OllamaReady) { return }
    $ollama = Resolve-Ollama
    Write-LauncherLog "Starting Ollama: $ollama"
    $stdout = Join-Path $stateDir 'ollama-serve.stdout.log'
    $stderr = Join-Path $stateDir 'ollama-serve.stderr.log'
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-OllamaReady) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-OllamaReady)) { throw "Ollama did not become ready within 30 seconds. See $stderr" }
}

function Get-CodexGuiProcesses {
    $all = @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
    $codex = @($all | Where-Object { $_.Path -like '*OpenAI.Codex_*' })
    if ($codex.Count -gt 0) {
        return @($all | ForEach-Object { [pscustomobject]@{ ProcessId = $_.Id } })
    }
    $cimMatches = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*OpenAI.Codex_*' -or $_.ExecutablePath -like '*OpenAI.Codex_*' })
    @($cimMatches | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId } })
}

function Get-CodexRequestHeaders {
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
    $authPath = Join-Path $codexHome 'auth.json'
    if (-not (Test-Path -LiteralPath $authPath)) { throw "Codex auth file not found: $authPath" }
    $auth = Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json
    if ($auth.tokens.access_token) {
        $headers = @{ Authorization = 'Bearer ' + $auth.tokens.access_token }
        if ($auth.tokens.account_id) { $headers['ChatGPT-Account-ID'] = $auth.tokens.account_id }
        return $headers
    }
    if ($auth.OPENAI_API_KEY) { return @{ Authorization = 'Bearer ' + $auth.OPENAI_API_KEY } }
    throw 'Codex auth.json contains neither a login token nor an API key.'
}

function Get-CodexAppId {
    $entry = Get-StartApps -ErrorAction SilentlyContinue |
        Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' -or $_.Name -eq 'Codex' } |
        Select-Object -First 1
    if ($entry) { return $entry.AppID }
    return $fallbackAppId
}

try {
    Write-LauncherLog "BEGIN PrepareOnly=$PrepareOnly SkipConnect=$SkipConnect Repo=$PSScriptRoot"
    Ensure-OllamaReady

    if (-not $SkipConnect) {
        $node = Resolve-Node
        $connector = Join-Path $PSScriptRoot 'connect.mjs'
        if (-not (Test-Path -LiteralPath $connector)) { throw "Missing connector: $connector" }
        Write-LauncherLog "Connecting with Node: $node"
        $connectStdout = Join-Path $stateDir 'connect.stdout.log'
        $connectStderr = Join-Path $stateDir 'connect.stderr.log'
        $connectorArgument = '"' + $connector + '"'
        $connectProcess = Start-Process -FilePath $node -ArgumentList @($connectorArgument, '--no-shortcut') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $connectStdout -RedirectStandardError $connectStderr
        foreach ($outputPath in @($connectStdout, $connectStderr)) {
            if (Test-Path -LiteralPath $outputPath) {
                Get-Content -LiteralPath $outputPath | ForEach-Object {
                    Write-Host $_
                    Write-LauncherLog "CONNECT $_"
                }
            }
        }
        $connectExitCode = $connectProcess.ExitCode
        if ($connectExitCode -ne 0) { throw "Codex connection setup exited with status $connectExitCode." }
    }

    $requestHeaders = Get-CodexRequestHeaders
    $catalog = Invoke-RestMethod -Headers $requestHeaders `
        -Uri "$endpoint/api/codex/v1/models?client_version=0.0.0" -TimeoutSec 10
    $modelCount = @($catalog.models).Count
    if ($modelCount -lt 1) { throw 'The Ollama Codex endpoint returned no models.' }
    Write-LauncherLog "Verified Ollama Codex endpoint with $modelCount models."

    if ($PrepareOnly) {
        Write-LauncherLog 'PREPARE SUCCESS; Codex was left running.'
        Write-Host "Desktop launcher preflight passed. Log: $logPath" -ForegroundColor Green
        exit 0
    }

    $processes = @(Get-CodexGuiProcesses)
    if ($processes.Count -gt 0) {
        $ids = @($processes | ForEach-Object { $_.ProcessId })
        Write-LauncherLog "Closing Codex process IDs: $($ids -join ', ')"
        foreach ($processId in $ids) {
            Stop-Process -Id $processId -Force -ErrorAction Stop
        }
        $closeDeadline = (Get-Date).AddSeconds(15)
        while (@(Get-CodexGuiProcesses).Count -gt 0 -and (Get-Date) -lt $closeDeadline) {
            Start-Sleep -Milliseconds 250
        }
        if (@(Get-CodexGuiProcesses).Count -gt 0) { throw 'Codex did not close within 15 seconds.' }
    } else {
        Write-LauncherLog 'Codex was not running.'
    }

    $appId = Get-CodexAppId
    Write-LauncherLog "Opening Codex AppID: $appId"
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') `
        -ArgumentList "shell:AppsFolder\$appId" -WindowStyle Normal
    $launchDeadline = (Get-Date).AddSeconds(30)
    while (@(Get-CodexGuiProcesses).Count -eq 0 -and (Get-Date) -lt $launchDeadline) {
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-CodexGuiProcesses).Count -eq 0) { throw 'Codex did not start within 30 seconds.' }
    Write-LauncherLog 'SUCCESS Codex restarted with the refreshed Ollama model catalog.'
}
catch {
    $message = $_.Exception.Message
    Write-LauncherLog "ERROR $message"
    if ($PrepareOnly) {
        Write-Error "$message (Log: $logPath)"
        exit 1
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "$message`r`n`r`nLog: $logPath",
        'Local Codex launcher failed',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

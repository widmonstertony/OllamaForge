[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$adapterRunner = Join-Path $PSScriptRoot 'run-codex-ollama-adapter.mjs'
$runtimeDir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('UserProfile') }) 'CodexOllama'
$stderrLog = Join-Path $runtimeDir 'codex-ollama-adapter.stderr.log'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$env:CODEX_LOCAL_RUNTIME_DIR = $runtimeDir
try {
    # Node handles raw append-only stdout/stderr streams. PowerShell 5.1
    # native redirection can otherwise turn stderr into a terminating error.
    & $nodeExe $adapterRunner
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) { throw "Adapter exited with code $nodeExitCode." }
    exit 0
} catch {
    Add-Content -LiteralPath $stderrLog -Value ("{0:u} Adapter task failed: {1}" -f (Get-Date), $_.Exception.Message) -Encoding utf8
    exit 1
}

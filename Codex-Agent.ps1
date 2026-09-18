[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$Model = 'qwen3.8-codex-16k',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Prompt
)

$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path
& (Join-Path $PSScriptRoot 'Start-CodexOllama.ps1')
$localCatalog = Join-Path $PSScriptRoot 'local-qwen-catalog.json'
if (-not (Test-Path -LiteralPath $localCatalog)) { throw "Local model catalog not found: $localCatalog" }

$codexArgs = @(
    '-C', $Project,
    '-m', $Model,
    '-s', 'workspace-write',
    '-a', 'on-request',
    '-c', 'model_provider="ollama_codex_adapter"',
    '-c', ('model_catalog_json="' + $localCatalog.Replace('\', '\\') + '"'),
    '-c', 'model_context_window=16384',
    '-c', 'model_auto_compact_token_limit=13000',
    '-c', 'model_reasoning_effort="medium"',
    '-c', 'model_supports_reasoning_summaries=false',
    '-c', 'model_providers.ollama_codex_adapter.name="Local Ollama via Codex adapter"',
    '-c', 'model_providers.ollama_codex_adapter.base_url="http://127.0.0.1:11435/v1"',
    '-c', 'model_providers.ollama_codex_adapter.wire_api="responses"',
    '-c', 'model_providers.ollama_codex_adapter.request_max_retries=1',
    '-c', 'model_providers.ollama_codex_adapter.stream_max_retries=1',
    '--disable', 'plugins',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'image_generation',
    '--disable', 'multi_agent'
)

if ($Prompt.Count -gt 0) { $codexArgs += ($Prompt -join ' ') }
& codex @codexArgs
exit $LASTEXITCODE

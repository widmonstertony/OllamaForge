[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try {
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $PSScriptRoot 'connect.mjs') --launch --no-shortcut
    if ($LASTEXITCODE -ne 0) { throw "Codex connection launcher exited with status $LASTEXITCODE." }
}
catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        '无法打开本地 Codex',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

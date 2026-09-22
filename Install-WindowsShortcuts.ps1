[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$explorer = Join-Path $env:SystemRoot 'explorer.exe'
$shell = New-Object -ComObject WScript.Shell
$entries = @(
    @{
        Name = '本地 Codex（GUI）'
        Target = $explorer
        Arguments = 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
        Description = '打开 Codex，通过 Ollama 11434 原生网关选择本地模型'
    }
)
foreach ($entry in $entries) {
    if (-not (Test-Path -LiteralPath $entry.Target)) { throw "Missing shortcut target: $($entry.Target)" }
    $shortcutPath = Join-Path $desktop ($entry.Name + '.lnk')
    if ($PSCmdlet.ShouldProcess($shortcutPath, 'Create or update Codex shortcut')) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $entry.Target
        $shortcut.Arguments = $entry.Arguments
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Description = $entry.Description
        $shortcut.Save()
        Write-Host "Ready: $shortcutPath"
    }
}

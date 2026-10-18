# Requires Windows PowerShell 5.1+ and Node.js in PATH.
# Dry run by default. Use: .\install.ps1 -Apply
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$hooksFile = Join-Path $codexHome 'hooks.json'
$adapterDir = Join-Path $codexHome 'hooks'
$notifyFile = Join-Path $HOME '.claude\notifications\notify.ps1'
$targets = @(
    [pscustomobject]@{ Source=(Join-Path $here 'codex-hooks\code-notify-stop.js'); Dest=(Join-Path $adapterDir 'code-notify-stop.js') },
    [pscustomobject]@{ Source=(Join-Path $here 'codex-hooks\codex-rollout.js'); Dest=(Join-Path $adapterDir 'codex-rollout.js') },
    [pscustomobject]@{ Source=(Join-Path $here 'shared-code-notify\notify.ps1'); Dest=$notifyFile }
)
if (-not (Test-Path -LiteralPath $hooksFile)) { throw "Missing Codex hooks configuration: $hooksFile" }
$hooks = Get-Content -LiteralPath $hooksFile -Raw | ConvertFrom-Json
$commands = @($hooks.hooks.Stop | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
if (-not @($commands | Where-Object { $_ -match 'code-notify-stop\.js' }).Count) {
    throw 'Existing code-notify-stop.js hook not found. Aborting rather than editing hook registrations automatically.'
}
if (-not @($commands | Where-Object { $_ -match 'notify-toast\.py' }).Count) {
    Write-Warning 'notify-toast.py was not found among Stop hooks. Installer will NOT add/remove it.'
}
foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t.Source)) { throw "Missing source: $($t.Source)" }
    Write-Host "Will replace $($t.Dest)"
}
$configPath = Join-Path $codexHome 'config.toml'
if (Test-Path $configPath) {
    $legacy = Select-String -Path $configPath -Pattern '^\s*notify\s*=' -ErrorAction SilentlyContinue
    if ($legacy) { Write-Warning 'Legacy notify= detected in config.toml. Remove this setting manually after confirming Stop hooks work to avoid duplicates/error 206.' }
}
if (-not $Apply) {
    Write-Host 'DRY RUN ONLY. No files changed. Exit all Codex sessions, then run .\install.ps1 -Apply'
    exit 0
}
$backupRoot = Join-Path $codexHome 'notification-backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$manifest = @()
foreach ($t in $targets) {
    $wasPresent = Test-Path -LiteralPath $t.Dest
    $backupFile = Join-Path $backupDir ([IO.Path]::GetFileName($t.Dest))
    if ($wasPresent) { Copy-Item -LiteralPath $t.Dest -Destination $backupFile -Force }
    $manifest += [pscustomobject]@{ Destination=$t.Dest; Existed=$wasPresent; BackupFile=$backupFile }
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $backupDir 'manifest.json')
foreach ($t in $targets) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $t.Dest) -Force | Out-Null
    Copy-Item -LiteralPath $t.Source -Destination $t.Dest -Force
}
Write-Host "Installation complete. Backups at $backupDir"
Write-Host "Rollback: .\rollback.ps1 -BackupDirectory '$backupDir'"
Write-Host 'NOTE: hooks.json, config.toml, save-final.py, notify-toast.py, channels.json were untouched.'

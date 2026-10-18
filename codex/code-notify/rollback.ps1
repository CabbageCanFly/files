# Example: .\rollback.ps1 -BackupDirectory 'C:\Users\James\.codex\notification-backups\20261018-010000' -Apply
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackupDirectory, [switch]$Apply)
$ErrorActionPreference='Stop'
$manifestPath = Join-Path $BackupDirectory 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Backup manifest not found: $manifestPath" }
$manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
foreach ($entry in $manifest) {
    $action = if ($entry.Existed) { "restore $($entry.BackupFile) -> $($entry.Destination)" } else { "remove newly created $($entry.Destination)" }
    Write-Host $action
    if ($Apply) {
        if ($entry.Existed) { Copy-Item -LiteralPath $entry.BackupFile -Destination $entry.Destination -Force }
        else { Remove-Item -LiteralPath $entry.Destination -Force -ErrorAction SilentlyContinue }
    }
}
if (-not $Apply) { Write-Host 'DRY RUN ONLY. Add -Apply to restore.' }

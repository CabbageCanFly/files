$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install.py'

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $installer
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    & python3 $installer
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python $installer
} else {
    throw 'Python 3 was not found. Install Python 3 and rerun this script.'
}

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

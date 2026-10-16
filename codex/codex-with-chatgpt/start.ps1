param(
    [ValidateSet('start', 'pair', 'status', 'stop', 'unpair')]
    [string]$Command = 'start',

    [string]$Workspace = 'H:\Desktop\codex'
)

$cli = Join-Path $PSScriptRoot 'codex-with-chatgpt\bin\c2c.js'

if (!(Test-Path $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

if ($Command -eq 'start') {
    node $cli start -w $Workspace --tunnel --json
} else {
    node $cli $Command -w $Workspace
}

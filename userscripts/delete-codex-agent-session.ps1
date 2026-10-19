
$root = "01a152a1-fb5a-7fb3-adec-f0feab3d1898"
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }

$folders = @(
    "$codexHome\sessions"
    "$codexHome\archived_sessions"
) | Where-Object { Test-Path $_ }

$nodes = @(
    Get-ChildItem $folders -Recurse -File -Filter "rollout-*.jsonl" |
    ForEach-Object {
        try {
            $p = (Get-Content $_.FullName -TotalCount 1 |
                ConvertFrom-Json).payload
            if ($p.id) {
                [pscustomobject]@{
                    Id = [string]$p.id
                    Parent = if ($p.history_base.thread_id) {
                        [string]$p.history_base.thread_id
                    } else {
                        [string]$p.forked_from_id
                    }
                }
            }
        } catch {
            Write-Warning "Unreadable: $($_.FullName)"
        }
    }
)

$depth = @{ $root = 0 }
do {
    $changed = $false
    foreach ($n in $nodes) {
        if ($depth.ContainsKey($n.Parent) -and
            -not $depth.ContainsKey($n.Id)) {
            $depth[$n.Id] = $depth[$n.Parent] + 1
            $changed = $true
        }
    }
} while ($changed)

$targets = @(
    $nodes |
    Where-Object { $depth.ContainsKey($_.Id) } |
    Sort-Object @{Expression = {$depth[$_.Id]}; Descending = $true}
)

$targets | Select-Object @{N="Depth";E={$depth[$_.Id]}},Id,Parent |
Format-Table -AutoSize

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "Node.js is required for the backend deletion step."
} elseif ($targets.Count -eq 0) {
    Write-Warning "No matching session files found."
} elseif ((Read-Host "Type DELETE to permanently delete all listed threads") -eq "DELETE") {

    $env:CODEX_DELETE_IDS = ConvertTo-Json -InputObject @($targets | ForEach-Object { $_.Id }) -Compress

    try {
@'
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const ids = JSON.parse(process.env.CODEX_DELETE_IDS);
const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: process.platform === "win32"
});

const rl = readline.createInterface({ input: proc.stdout });
let current = 0;
let failed = false;

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function fail(error) {
  if (failed) return;
  failed = true;
  console.error("DELETE FAILED:", error);
  process.exitCode = 1;
  proc.kill();
}

function next() {
  if (current >= ids.length) {
    console.log("All deletion requests succeeded.");
    proc.stdin.end();
    return;
  }
  const id = ids[current];
  current++;
  send({
    method: "thread/delete",
    id: current,
    params: { threadId: id }
  });
}

proc.on("error", e => fail(e.message));

rl.on("line", line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id === 0) {
    if (msg.error) return fail(JSON.stringify(msg.error));
    send({ method: "initialized", params: {} });
    next();
  } else if (msg.id === current && current > 0) {
    if (msg.error) {
      fail(ids[current - 1] + ": " + JSON.stringify(msg.error));
    } else {
      console.log("Deleted:", ids[current - 1]);
      next();
    }
  }
});

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "local_session_cleanup",
      title: "Local Session Cleanup",
      version: "1.0.0"
    }
  }
});
'@ | node -
    } finally {
        Remove-Item Env:CODEX_DELETE_IDS -ErrorAction SilentlyContinue
    }
}

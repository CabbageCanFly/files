"""Show a simple Windows toast when the Claude Code Stop hook fires."""
import json
import subprocess
import sys
from pathlib import Path

try:
    event = json.load(sys.stdin)
    if not event.get("stop_hook_active"):
        project = Path(event.get("cwd") or "").name or "Unknown project"
        subprocess.run(
            [
                r"C:\Shortcuts\exe\toasty.exe",
                f"Project: {project}",
                "-t", "Claude finished",
                "--app", "claude",
            ],
            timeout=8,
            check=True,
        )
except Exception as exc:
    print(f"Claude toast notification failed: {exc}", file=sys.stderr)
finally:
    print("{}")

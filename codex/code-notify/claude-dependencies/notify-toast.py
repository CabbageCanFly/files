"""Claude Code Stop hook: Toasty notification with session title, project fallback."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".config" / "code-notify"))

try:
    from session_title import get_title
    event = json.load(sys.stdin)
    if not event.get("stop_hook_active"):
        project = Path(event.get("cwd") or "").name or "Unknown project"
        title = get_title("claude", event)
        message = f"{title}\nProject: {project}" if title else f"Project: {project}"
        subprocess.run(
            [r"C:\Shortcuts\exe\toasty.exe", message, "-t", "Claude finished", "--app", "claude"],
            timeout=8,
            check=True,
        )
except Exception as exc:
    print(f"Claude toast notification failed: {exc}", file=sys.stderr)
finally:
    print("{}")

"""Codex Stop hook: Toasty notification with session title, project fallback."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".config" / "code-notify"))

try:
    from session_title import get_title
    event = json.load(sys.stdin)
    project = Path(event.get("cwd") or "").name or "Unknown project"
    title = get_title("codex", event)
    message = f"{title}\nProject: {project}" if title else f"Project: {project}"
    subprocess.run(
        [r"C:\Shortcuts\exe\toasty.exe", message, "-t", "Codex finished", "--app", "codex"],
        timeout=8,
        check=True,
    )
except Exception as exc:
    print(f"Toast notification failed: {exc}", file=sys.stderr)
finally:
    print("{}")

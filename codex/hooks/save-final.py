"""Codex Stop hook: save the latest assistant response inside Git metadata."""

import json
import subprocess
import sys
from pathlib import Path


def main():
    event = json.load(sys.stdin)
    message = event.get("last_assistant_message")
    cwd = event.get("cwd")
    if not message or not cwd:
        return

    result = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--absolute-git-dir"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=5,
    )
    if result.returncode != 0:
        return

    output_dir = Path(result.stdout.strip()) / "codex-output"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "latest.md").write_text(message.rstrip() + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Could not save Codex output: {exc}", file=sys.stderr)
    finally:
        # Stop hooks require valid JSON on stdout.
        print("{}")

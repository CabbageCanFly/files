"""Codex Stop hook: atomically save the latest assistant response."""

import json
import os
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime
from pathlib import Path

LOG = Path.home() / ".codex" / "stop-hook.log"


def log(message):
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {message}\n")
    except OSError as exc:
        print(f"Hook logging failed: {exc}", file=sys.stderr)


def main():
    log("INVOKED")
    event = json.loads(sys.stdin.buffer.read().decode("utf-8"))

    message = event.get("last_assistant_message")
    cwd = event.get("cwd")

    if not isinstance(message, str) or not message.strip():
        log(f"SKIPPED: missing/empty message; keys={list(event)}")
        return

    if not isinstance(cwd, str) or not cwd:
        log("SKIPPED: missing cwd")
        return

    result = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--absolute-git-dir"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=5,
    )

    if result.returncode != 0:
        log(f"FAILED: git lookup; cwd={cwd}; error={result.stderr.strip()}")
        return

    output_dir = Path(result.stdout.strip()) / "codex-output"
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "latest.md"

    # Write to a temporary file, then atomically replace latest.md.
    fd, temp_path = tempfile.mkstemp(
        prefix="latest-", suffix=".tmp", dir=output_dir
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(message.rstrip() + "\n")
        os.replace(temp_path, target)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)

    log(f"SAVED: {len(message)} characters -> {target}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log(f"FAILED: {traceback.format_exc().strip()}")
    finally:
        print("{}")

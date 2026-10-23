"""Read-only Codex / Claude Code session title lookup; no third-party packages.

CLI: python session_title.py codex|claude < hook.json
Or:  python session_title.py codex|claude SESSION_ID [TRANSCRIPT_PATH]
Prints an empty line when an exact session title cannot be resolved.
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

SESSION_ID = re.compile(r"^[a-zA-Z0-9_-]{6,100}$")


def _clean(value):
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:120]


def _codex(event):
    session_id = event.get("session_id") or event.get("thread-id")
    if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        return ""
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    index = root / "session_index.jsonl"
    try:
        with index.open("rb") as stream:
            size = stream.seek(0, 2)
            offset = max(0, size - 8 * 1024 * 1024)
            stream.seek(offset)
            raw = stream.read().decode("utf-8-sig", "replace")
        if offset:
            raw = raw.partition("\n")[2]
        for line in reversed(raw.splitlines()):
            try:
                entry = json.loads(line)
                if entry.get("id") == session_id:
                    title = _clean(entry.get("thread_name"))
                    if title:
                        return title
            except (ValueError, AttributeError, TypeError):
                continue
    except OSError:
        pass

    # Some Codex titles exist only in the SQLite thread index.
    sqlite_root = Path(os.environ.get("CODEX_SQLITE_HOME") or os.environ.get("CODEX_HOME") or root)
    for db in (sqlite_root / "state_5.sqlite", sqlite_root / "sqlite" / "state_5.sqlite"):
        if not db.is_file():
            continue
        try:
            with sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=0.5) as conn:
                row = conn.execute("SELECT title FROM threads WHERE id = ?", (session_id,)).fetchone()
            if row:
                title = _clean(row[0])
                if title:
                    return title
        except (sqlite3.Error, OSError, ValueError):
            continue
    return ""


def _claude(event):
    session_id = event.get("session_id")
    transcript = event.get("transcript_path")
    if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        return ""
    if not isinstance(transcript, str) or not transcript:
        return ""
    root = (Path.home() / ".claude" / "projects").resolve()
    path = Path(transcript).resolve()
    if not path.is_relative_to(root) or path.name != f"{session_id}.jsonl":
        return ""
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, 2)
            offset = max(0, size - 16 * 1024 * 1024)
            stream.seek(offset)
            raw = stream.read().decode("utf-8-sig", "replace")
        if offset:
            raw = raw.partition("\n")[2]
    except OSError:
        return ""
    custom = generated = ""
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                continue
            if entry.get("sessionId", session_id) != session_id:
                continue
            if entry.get("type") == "custom-title":
                custom = _clean(entry.get("customTitle"))
            elif entry.get("type") == "ai-title":
                generated = _clean(entry.get("aiTitle"))
        except (ValueError, TypeError):
            continue
    return custom or generated


def get_title(agent, event):
    if not isinstance(event, dict):
        return ""
    try:
        return _codex(event) if agent == "codex" else _claude(event) if agent == "claude" else ""
    except Exception:
        return ""  # Never break a Stop hook because a title is missing.


if __name__ == "__main__":
    try:
        if len(sys.argv) > 2:
            event = {"session_id": sys.argv[2], "thread-id": sys.argv[2]}
            if len(sys.argv) > 3:
                event["transcript_path"] = sys.argv[3]
        else:
            event = json.load(sys.stdin)
        print(get_title(sys.argv[1], event))
    except (IndexError, ValueError):
        print("")

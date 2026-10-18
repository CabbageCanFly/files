#!/usr/bin/env python3
"""Install this repo's Codex Stop hook into the current user's Codex home."""

import copy
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def hook_command(script: Path) -> str:
    args = [sys.executable, str(script)]
    if os.name == "nt":
        return subprocess.list2cmdline(args)
    return " ".join(shlex.quote(arg) for arg in args)


def load_hooks(path: Path) -> dict:
    if not path.exists():
        return {"hooks": {}}
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("hooks.json must contain a JSON object")
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("hooks.json 'hooks' must be an object")
    if "Stop" in hooks and not isinstance(hooks["Stop"], list):
        raise ValueError("hooks.json 'hooks.Stop' must be an array")
    return data


def configure_hook(data: dict, command: str) -> dict:
    updated = copy.deepcopy(data)
    stop = updated["hooks"].setdefault("Stop", [])

    # Reinstalling replaces our prior command instead of adding another hook.
    for group in stop:
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            continue
        for handler in group["hooks"]:
            if (
                isinstance(handler, dict)
                and handler.get("type") == "command"
                and "save-final.py" in str(handler.get("command", ""))
            ):
                handler["command"] = command
                return updated

    stop.append({"hooks": [{"type": "command", "command": command, "timeout": 10}]})
    return updated


def backup_once(path: Path) -> None:
    backup = path.with_name(path.name + ".bak")
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
        print(f"Backed up: {backup}")


def write_json_atomic(path: Path, data: dict) -> None:
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=".hooks-", suffix=".tmp", delete=False
        ) as f:
            temp_path = Path(f.name)
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()


def main() -> int:
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    if not codex_home.is_dir():
        print(f"Codex directory not found: {codex_home}")
        print("Install/run Codex first, then rerun this installer. Nothing changed.")
        return 1

    source = Path(__file__).resolve().parent / "hooks" / "save-final.py"
    if not source.is_file():
        print(f"Missing source hook: {source}", file=sys.stderr)
        return 1

    target = codex_home / "hooks" / "save-final.py"
    hooks_path = codex_home / "hooks.json"

    # Validate existing JSON before changing any files.
    config = load_hooks(hooks_path)
    updated = configure_hook(config, hook_command(target))

    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or target.read_bytes() != source.read_bytes():
        backup_once(target)
        shutil.copy2(source, target)
        print(f"Installed: {target}")
    else:
        print(f"Already installed: {target}")

    if config != updated or not hooks_path.exists():
        backup_once(hooks_path)
        write_json_atomic(hooks_path, updated)
        print(f"Configured: {hooks_path}")
    else:
        print(f"Already configured: {hooks_path}")

    print("Restart Codex, then review/trust the hook using /hooks.")
    print("Test in a Git repo: git rev-parse --absolute-git-dir")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        raise SystemExit(1)

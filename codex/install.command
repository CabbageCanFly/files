#!/bin/bash
set -e

script_dir="$(cd "$(dirname "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3 was not found. Install Python 3 and rerun this script.' >&2
  exit 1
fi

python3 "$script_dir/install.py"

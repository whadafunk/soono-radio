#!/usr/bin/env bash
# Creates a Python virtual environment and installs audio analysis dependencies.
# Run once: ./analysis/setup.sh
# Then run: ./analysis/download_models.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
ESSENTIA_INDEX="https://essentia.upf.edu/python-extras/"

# Essentia requires Python 3.11 or 3.12 — 3.13+ have no binary wheels yet.
PYTHON=""
for candidate in python3.11 python3.12; do
  if command -v "$candidate" &>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "ERROR: Python 3.11 or 3.12 required (3.13+ not yet supported by essentia)."
  echo "Install with: brew install python@3.11"
  exit 1
fi
echo "Using $($PYTHON --version)"

echo "Creating virtual environment at $VENV_DIR ..."
"$PYTHON" -m venv "$VENV_DIR"

echo "Installing core dependencies (aubio + essentia + numpy) ..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" --quiet

echo "Installing essentia-tensorflow (mood models) from Essentia's index ..."
if "$VENV_DIR/bin/pip" install essentia-tensorflow \
    --extra-index-url "$ESSENTIA_INDEX" --quiet 2>/dev/null; then
  echo "  essentia-tensorflow installed — mood classification available."
else
  echo "  essentia-tensorflow not available for this platform."
  echo "  BPM, key, energy and danceability will still work; mood_tags will be empty."
fi

echo ""
echo "Done. Next step: ./analysis/download_models.sh"

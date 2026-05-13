#!/usr/bin/env bash
# Downloads Essentia MusiCNN mood classification models.
# Models are placed in analysis/models/ (gitignored).
# Run once before using audio analysis: ./analysis/download_models.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="$SCRIPT_DIR/models"
BASE_URL="https://essentia.upf.edu/models"

mkdir -p "$MODELS_DIR"

echo "Downloading Essentia MusiCNN models to $MODELS_DIR ..."

# MusiCNN embedding model (shared across all classifiers)
download() {
  local url="$1"
  local dest="$MODELS_DIR/$(basename "$url")"
  if [ -f "$dest" ]; then
    echo "  already present: $(basename "$dest")"
  else
    echo "  downloading: $(basename "$url")"
    curl -sSfL "$url" -o "$dest"
  fi
}

download "$BASE_URL/feature-extractors/musicnn/msd-musicnn-1.pb"

# Mood classifiers
for mood in happy sad aggressive relaxed party acoustic electronic; do
  download "$BASE_URL/classification-heads/mood_${mood}/mood_${mood}-msd-musicnn-1.pb"
done

echo "Done. Models saved to $MODELS_DIR"

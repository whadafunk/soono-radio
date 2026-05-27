#!/bin/bash

# Start Liquidsoap container for local development
# Mirrors start-icecast.sh — same image-build + run pattern.
# Run this in one terminal AFTER ./start-icecast.sh is up, then `pnpm dev` in another.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

# The media directory is mounted at /media inside the container.
# Write LS_MEDIA_DIR=/media into the repo .env so the API generates
# correct annotated URIs for LiquidSoap without needing a manual export.
if grep -q "^LS_MEDIA_DIR=" "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^LS_MEDIA_DIR=.*|LS_MEDIA_DIR=/media|" "$ENV_FILE"
else
  echo "LS_MEDIA_DIR=/media" >> "$ENV_FILE"
fi
echo "Set LS_MEDIA_DIR=/media in .env"

echo "Building Liquidsoap image..."
docker buildx build -t radio-liquidsoap:latest --load liquidsoap/

echo "Starting Liquidsoap container..."
docker run \
  -it \
  --name radio-liquidsoap \
  --rm \
  --user "$(id -u):$(id -g)" \
  --add-host=host.docker.internal:host-gateway \
  -p 8005:8005 \
  -p 127.0.0.1:1234:1234 \
  -v "$REPO_ROOT/liquidsoap/mix-engine.liq:/etc/liquidsoap/mix-engine.liq:ro" \
  -v "$REPO_ROOT/liquidsoap/audio:/audio" \
  -v "$REPO_ROOT/media:/media:ro" \
  -v "$REPO_ROOT/data/certs:/etc/icecast2/certs:ro" \
  radio-liquidsoap:latest

# To stop: Ctrl+C or `docker stop radio-liquidsoap`

#!/bin/bash

# Start Liquidsoap container for local development
# Mirrors start-icecast.sh — same image-build + run pattern.
# Run this in one terminal AFTER ./start-icecast.sh is up, then `pnpm dev` in another.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
  echo "Set ${key}=${val} in .env"
}

# In dev mode LiquidSoap runs in Docker but the API runs on the host.
# These override the compose defaults so the dev API generates the right values:
#   LS_MEDIA_DIR — mount point inside the LS container
#   LS_API_URL   — URL LiquidSoap uses to call back into the host API
set_env LS_MEDIA_DIR /media
set_env LS_API_URL http://host.docker.internal:3000

echo "Building Liquidsoap image..."
docker buildx build -t soono-liquidsoap:latest --load liquidsoap/

echo "Starting Liquidsoap container..."
docker run \
  -it \
  --name soono-liquidsoap \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --add-host=host.docker.internal:host-gateway \
  -p 8005:8005 \
  -p 127.0.0.1:1234:1234 \
  -v "$REPO_ROOT/liquidsoap/mix-engine.liq:/etc/liquidsoap/mix-engine.liq:ro" \
  -v "$REPO_ROOT/media:/media:ro" \
  -v "$REPO_ROOT/data/certs:/etc/liquidsoap/certs:ro" \
  -v "$REPO_ROOT/logs/liquidsoap:/var/log/liquidsoap" \
  soono-liquidsoap:latest

# To stop: Ctrl+C or `docker stop soono-liquidsoap`

#!/bin/bash

# Start Liquidsoap container for local development
# Mirrors start-icecast.sh — same image-build + run pattern.
# Run this in one terminal AFTER ./start-icecast.sh is up, then `pnpm dev` in another.
#
# IMPORTANT: the media directory is mounted at /media inside the container.
# The API must know this so it generates correct annotated URIs for LiquidSoap.
# Before running `pnpm dev`, export:
#   export LS_MEDIA_DIR=/media
# Or set it in your .env file at the repo root.

set -e

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
  -v "$(pwd)/liquidsoap/mix-engine.liq:/etc/liquidsoap/mix-engine.liq:ro" \
  -v "$(pwd)/liquidsoap/audio:/audio" \
  -v "$(pwd)/media:/media:ro" \
  -v "$(pwd)/data/certs:/etc/icecast2/certs:ro" \
  radio-liquidsoap:latest

# To stop: Ctrl+C or `docker stop radio-liquidsoap`

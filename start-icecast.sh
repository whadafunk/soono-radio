#!/bin/bash

# Start Icecast container for local development
# Builds a lightweight arm64-compatible image from icecast/Dockerfile
# Run this in one terminal, then `pnpm dev` in another

set -e

echo "Building Icecast image..."
docker buildx build -t soono-icecast:latest --load icecast/

echo "Starting Icecast container..."
docker run \
  -it \
  --name soono-icecast \
  --rm \
  --user "$(id -u):$(id -g)" \
  -p 8000:8000 \
  -p 8001:8001 \
  -v "$(pwd)/icecast/icecast.xml:/etc/icecast2/icecast.xml" \
  -v "$(pwd)/icecast/logs:/usr/local/icecast/logs" \
  -v "$(pwd)/data/certs:/etc/icecast2/certs:ro" \
  soono-icecast:latest

# To stop: Ctrl+C or `docker stop soono-icecast`

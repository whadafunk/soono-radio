#!/bin/bash

# Start Icecast container for local development
# Builds a lightweight arm64-compatible image from icecast/Dockerfile
# Run this in one terminal, then `pnpm dev` in another

set -e

echo "Building Icecast image..."
docker buildx build -t radio-icecast:latest --load icecast/

echo "Starting Icecast container..."
docker run \
  --name radio-icecast \
  --rm \
  -p 8000:8000 \
  -v "$(pwd)/icecast/icecast.xml:/etc/icecast.xml" \
  radio-icecast:latest

# To stop: Ctrl+C or `docker stop radio-icecast`

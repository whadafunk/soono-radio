#!/bin/bash

# Start Icecast container for local development
# Run this in one terminal, then `pnpm dev` in another

docker run \
  --name radio-icecast \
  --rm \
  -p 8000:8000 \
  -v "$(pwd)/icecast/icecast.xml:/etc/icecast.xml" \
  infiniteproject/icecast:latest

# To stop: Ctrl+C or `docker stop radio-icecast`

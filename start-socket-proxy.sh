#!/bin/bash

# Start the Docker socket proxy for local development.
# Exposes a narrow Docker API slice on 127.0.0.1:2375 so the API can
# restart Icecast and LiquidSoap containers without a full compose stack.
#
# The API defaults to DOCKER_PROXY_URL=http://localhost:2375, which matches
# the port exposed here. No .env change needed for dev.
#
# To stop: Ctrl+C or `docker stop soono-socket-proxy-dev`

set -e

docker run \
  -it \
  --name soono-socket-proxy-dev \
  --rm \
  -p 127.0.0.1:2375:2375 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e CONTAINERS=1 \
  -e POST=1 \
  tecnativa/docker-socket-proxy

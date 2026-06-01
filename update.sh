#!/bin/bash
set -euo pipefail

LOGFILE="./logs/update.log"
mkdir -p ./logs

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"
}

log "=== Update started ==="

log "Pulling latest code..."
# --ff-only: fail if the server has diverged from origin rather than auto-merging
git pull --ff-only

log "Building images..."
docker compose build

log "Restarting containers..."
docker compose up -d

log "Pruning old images..."
docker image prune -f

log "=== Update complete ==="

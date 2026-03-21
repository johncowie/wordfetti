#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="/srv/containers/wordfetti"
REPO_DIR="/home/anthony/sideProjects/wordfetti"

echo "==> Pulling latest code..."
git -C "$REPO_DIR" pull --ff-only

echo "==> Rebuilding and restarting container..."
cd "$COMPOSE_DIR"
docker compose up -d --build

echo "==> Pruning old images..."
docker image prune -f

echo "==> Done."

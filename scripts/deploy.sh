#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="/srv/containers/wordfetti"
REPO_DIR="/home/anthony/sideProjects/wordfetti"

git -C "$REPO_DIR" fetch --quiet
BEHIND=$(git -C "$REPO_DIR" rev-list HEAD..@{u} --count 2>/dev/null || echo 0)
if [ "$BEHIND" -gt 0 ]; then
  echo "Note: $BEHIND new commit(s) available on remote (run git pull to update)"
fi

echo "==> Rebuilding and restarting container..."
cd "$COMPOSE_DIR"
docker compose up -d --build

echo "==> Pruning old images..."
docker image prune -f

echo "==> Done. Tailing logs (Ctrl+C to exit)..."
docker compose logs --tail=30 --follow

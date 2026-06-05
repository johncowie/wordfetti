#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Installing workspace dependencies..."
pnpm install

echo "Installing Playwright Chromium..."
pnpm --filter e2e exec playwright install chromium

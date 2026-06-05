#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Install deps and browser binaries if needed
bash "$SCRIPT_DIR/e2e-setup.sh"

# ── Port selection ────────────────────────────────────────────────────────────
# Try 3 odd client-port candidates; API port is client+2.
# Odd ports in the 7300s are unlikely to conflict with common dev tools.
is_port_free() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -i :"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    ! ss -tlnp 2>/dev/null | grep -q ":${port}[[:space:]]"
  fi
}

CLIENT_PORT=""
SERVER_PORT=""
for candidate in 7373 7375 7377; do
  api_candidate=$((candidate + 2))
  if is_port_free "$candidate" && is_port_free "$api_candidate"; then
    CLIENT_PORT=$candidate
    SERVER_PORT=$api_candidate
    break
  fi
done

if [ -z "$CLIENT_PORT" ]; then
  echo "Error: Could not find free ports after 3 attempts (tried 7373/7375, 7375/7377, 7377/7379)" >&2
  exit 1
fi

echo "Using client port $CLIENT_PORT, API port $SERVER_PORT"

# ── Startup & cleanup ─────────────────────────────────────────────────────────
CLIENT_PID=""
SERVER_PID=""
LOG_DIR="$(mktemp -d)"

# Kill a process and all its descendants. Only touches PIDs we own.
kill_tree() {
  local pid=$1
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  echo "Stopping dev servers..."
  [ -n "$SERVER_PID" ] && kill_tree "$SERVER_PID"
  [ -n "$CLIENT_PID" ] && kill_tree "$CLIENT_PID"
  wait 2>/dev/null || true
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

# Start API server
PORT=$SERVER_PORT pnpm --filter server dev >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

# Start Vite client
VITE_PORT="$CLIENT_PORT" VITE_API_URL="http://localhost:$SERVER_PORT" \
  pnpm --filter client dev >"$LOG_DIR/client.log" 2>&1 &
CLIENT_PID=$!

# ── Wait for servers to be ready ──────────────────────────────────────────────
echo "Waiting for API server (http://localhost:$SERVER_PORT/health)..."
attempts=0
until curl -sf "http://localhost:$SERVER_PORT/health" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ $attempts -ge 30 ]; then
    echo "Error: API server did not start within 30s" >&2
    echo "--- server log ---" >&2
    cat "$LOG_DIR/server.log" >&2
    exit 1
  fi
  sleep 1
done

echo "Waiting for Vite client (http://localhost:$CLIENT_PORT)..."
attempts=0
until curl -sf "http://localhost:$CLIENT_PORT" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ $attempts -ge 30 ]; then
    echo "Error: Vite client did not start within 30s" >&2
    echo "--- client log ---" >&2
    cat "$LOG_DIR/client.log" >&2
    exit 1
  fi
  sleep 1
done

echo "Dev servers ready. Running e2e tests..."

# ── Run tests ─────────────────────────────────────────────────────────────────
BASE_URL="http://localhost:$CLIENT_PORT" \
  API_BASE_URL="http://localhost:$SERVER_PORT" \
  pnpm --filter e2e test
